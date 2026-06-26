const API_BASE = "https://hotels.cloudbeds.com/api/v1.2";

export default async function handler(req, res) {
  const API_KEY = process.env.CLOUDBEDS_API_KEY;
  const PROPERTY_ID = process.env.PROPERTY_ID || "195814";

  try {
    if (!API_KEY) {
      return res.status(500).json({ success: false, error: "Falta CLOUDBEDS_API_KEY en las env vars de Vercel" });
    }

    const p = (req.method === "POST" && req.body) ? req.body : (req.query || {});
    const reservationIDArg = String(p.reservationID || "").trim();
    const nuevaFecha       = String(p.nueva_fecha_checkout || "").trim();
    const tarifaNoche      = num(p.tarifa_noche, NaN);
    const dryRun           = String(p.dryRun || "") === "true";

    if (!reservationIDArg || !nuevaFecha) {
      return res.status(400).json({ success: false, error: "Faltan reservationID o nueva_fecha_checkout" });
    }
    // GUARD DE PRECIO: nunca aplicar una tarifa vacia o <= 0 (evita cargar $0 si algo llega mal)
    if (!(tarifaNoche > 0)) {
      return res.status(400).json({ success: false, error: "tarifa_noche faltante o invalida (debe ser un numero > 0)" });
    }

    const grupoID = reservationIDArg.split("-")[0];

    // 1) Estructura de la reserva (camas) — igual que antes
    const getJson = await cb(`getReservation?propertyID=${PROPERTY_ID}&reservationID=${grupoID}`, API_KEY);
    if (!getJson.success) {
      return res.status(200).json({ success: false, step: "getReservation", error: getJson.message || "No se pudo leer la reserva" });
    }
    const assigned = (getJson.data && getJson.data.assigned) || [];
    if (assigned.length === 0) {
      return res.status(200).json({ success: false, error: "La reserva no tiene habitaciones asignadas" });
    }

    // 2) Tarifas por noche EXISTENTES de la reserva — para preservarlas tal cual
    const rateJson = await cb(`getReservationsWithRateDetails?propertyID=${PROPERTY_ID}&reservationID=${grupoID}`, API_KEY);
    const tarifasPorCama = indexarTarifasExistentes(rateJson);

    // 3) Armar putReservation: preservar TODO; extender SOLO la cama objetivo con tarifas por dia explicitas (sin adjustPrice)
    const params = new URLSearchParams();
    params.append("propertyID", PROPERTY_ID);
    params.append("reservationID", grupoID);

    let objetivoOK = false;
    let nochesNuevas = 0;
    const plan = [];

    assigned.forEach((room, i) => {
      const esObjetivo  = String(room.subReservationID) === reservationIDArg;
      if (esObjetivo) objetivoOK = true;

      const checkinDate = room.startDate;
      const oldCheckout = room.endDate;
      const newCheckout = esObjetivo ? nuevaFecha : oldCheckout;

      params.append(`rooms[${i}][subReservationID]`, room.subReservationID);
      params.append(`rooms[${i}][roomTypeID]`, room.roomTypeID);
      if (room.roomID) params.append(`rooms[${i}][roomID]`, room.roomID);
      params.append(`rooms[${i}][checkinDate]`, checkinDate);
      params.append(`rooms[${i}][checkoutDate]`, newCheckout);
      params.append(`rooms[${i}][adults]`, room.adults != null ? room.adults : 1);
      params.append(`rooms[${i}][children]`, room.children != null ? room.children : 0);
      params.append(`rooms[${i}][adjustPrice]`, "false"); // CLAVE: ya NO re-tarificamos

      if (!esObjetivo) {
        // Cama no objetivo: no cambian sus fechas -> no mandamos tarifas, Cloudbeds conserva las suyas intactas.
        plan.push({ cama: room.subReservationID, objetivo: false, sin_cambios: true, checkout: newCheckout });
        return;
      }

      // Cama objetivo: tarifas por dia explicitas = noches viejas PRESERVADAS + noche(s) nueva(s) a tarifa_noche
      const existentes = tarifasPorCama[String(room.subReservationID)] || {};
      const noches = enumerarNoches(checkinDate, newCheckout); // una entrada por noche (NO incluye el dia de checkout)
      const detalle = [];

      noches.forEach((fecha, j) => {
        const esNueva = fecha >= oldCheckout; // las noches desde el checkout viejo en adelante son las nuevas
        const rate = esNueva
          ? tarifaNoche
          : (existentes[fecha] != null ? existentes[fecha] : tarifaNoche); // fallback defensivo (lo marcamos abajo)
        if (esNueva) nochesNuevas++;
        params.append(`rooms[${i}][detailedRates][${j}][date]`, fecha);
        params.append(`rooms[${i}][detailedRates][${j}][rate]`, rate);
        detalle.push({
          fecha, rate, nueva: esNueva,
          origen: esNueva ? "tarifa_noche" : (existentes[fecha] != null ? "preservada" : "FALLBACK")
        });
      });

      plan.push({ cama: room.subReservationID, objetivo: true, checkin: checkinDate, checkout: newCheckout, noches: detalle });
    });

    if (!objetivoOK) {
      return res.status(200).json({
        success: false,
        error: `No se encontro la cama ${reservationIDArg} en el grupo ${grupoID}`,
        camas_en_grupo: assigned.map(r => r.subReservationID)
      });
    }

    const totalAdicional = Math.round(tarifaNoche * nochesNuevas * 100) / 100;

    // DryRun: NO escribe. Muestra lo que leyo, el plan de tarifas y el body que mandaria.
    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        grupo: grupoID,
        objetivo: reservationIDArg,
        tarifa_noche: tarifaNoche,
        noches_extra_derivadas: nochesNuevas,
        total_adicional: totalAdicional,
        tarifas_existentes_indexadas: tarifasPorCama,
        plan_por_cama: plan,
        body_preview: params.toString(),
        raw_rate_details: rateJson // <- para verificar los nombres de campo reales de getReservationsWithRateDetails
      });
    }

    // GUARD DE PRESERVACION: si no pudimos leer la tarifa real de alguna noche vieja, NO extendemos
    // (mejor bloquear que re-tarificar lo previo sin querer).
    const fallbacks = plan
      .filter(c => c.objetivo && Array.isArray(c.noches))
      .flatMap(c => c.noches)
      .filter(n => n.origen === "FALLBACK");
    if (fallbacks.length > 0) {
      return res.status(200).json({
        success: false,
        step: "preservacion_tarifas",
        error: "No pude leer la tarifa original de una o mas noches existentes; no extiendo para no alterar cargos previos. Corre con dryRun=true y revisa raw_rate_details.",
        noches_sin_tarifa: fallbacks,
        plan_por_cama: plan
      });
    }

    const putJson = await cb("putReservation", API_KEY, params.toString());
    if (!putJson.success) {
      return res.status(200).json({
        success: false, step: "putReservation",
        error: putJson.message || "putReservation fallo",
        body_preview: params.toString()
      });
    }

    // total_adicional se calcula DIRECTO (tarifa_noche x noches), no del delta del balance.
    return res.status(200).json({
      success: true,
      nueva_fecha_checkout: nuevaFecha,
      total_adicional: totalAdicional,
      moneda: "MXN",
      noches_extra: nochesNuevas,
      camas_preservadas: assigned.length,
      mensaje: `Listo, extendi tu cama hasta el ${nuevaFecha}. Total adicional: $${totalAdicional} MXN.`
    });

  } catch (e) {
    return res.status(500).json({ success: false, error: String((e && e.message) || e) });
  }
}

// ---------- helpers ----------

async function cb(pathOrMethod, apiKey, body) {
  const isWrite = !!body;
  const url = `${API_BASE}/${pathOrMethod}`;
  const opts = { headers: { "x-api-key": apiKey } };
  if (isWrite) {
    opts.method = "PUT";
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = body;
  }
  const r = await fetch(url, opts);
  return r.json();
}

function num(v, fallback = 0) {
  const n = parseFloat(v);
  return isNaN(n) ? fallback : n;
}

// Noches entre checkin (incluido) y checkout (excluido), formato YYYY-MM-DD. UTC-safe.
function enumerarNoches(checkin, checkout) {
  const out = [];
  const d   = new Date(`${checkin}T00:00:00Z`);
  const fin = new Date(`${checkout}T00:00:00Z`);
  while (d < fin) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Indexa tarifas existentes: { subReservationID: { 'YYYY-MM-DD': rate } }
// getReservationsWithRateDetails devuelve las tarifas por noche en room.detailedRoomRates
// como OBJETO { 'YYYY-MM-DD': rate } (no como arreglo). Confirmado contra la reserva real.
function indexarTarifasExistentes(rateJson) {
  const idx = {};
  if (!rateJson || rateJson.success === false) return idx;
  const data = rateJson.data;
  const reservas = Array.isArray(data) ? data : (data ? [data] : []);
  reservas.forEach(r => {
    const rooms = Array.isArray(r.rooms) ? r.rooms : [];
    rooms.forEach(room => {
      const sub = String(room.subReservationID || "");
      // objeto { 'YYYY-MM-DD': rate }; fallback a otros nombres por si acaso
      const rates = room.detailedRoomRates || room.detailedRates;
      if (!sub || !rates || typeof rates !== "object" || Array.isArray(rates)) return;
      idx[sub] = idx[sub] || {};
      Object.entries(rates).forEach(([fecha, rate]) => {
        const r2 = num(rate, NaN);
        // se preservan TODAS las tarifas, incluido $0 (noche de cortesia), no solo > 0
        if (fecha && !isNaN(r2)) idx[sub][String(fecha).slice(0, 10)] = r2;
      });
    });
  });
  return idx;
}
