const API_BASE = "https://hotels.cloudbeds.com/api/v1.2";

// ENFOQUE postAdjustment (plan B documentado):
// putReservation no acepta escritura de tarifas por dia (probado: "Number of days not
// equals to number of day rates" con detailedRates/detailedRoomRates en arreglo y objeto).
// Cloudbeds documenta postAdjustment como la via oficial para sobrescribir precio.
// Flujo: extender con adjustPrice=true (recalcula) -> medir el cambio real de saldo ->
// corregir con postAdjustment para que el cargo neto sea EXACTAMENTE tarifa_noche x noches.

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
    // GUARD DE PRECIO: nunca operar con tarifa vacia o <= 0
    if (!(tarifaNoche > 0)) {
      return res.status(400).json({ success: false, error: "tarifa_noche faltante o invalida (debe ser un numero > 0)" });
    }

    const grupoID = reservationIDArg.split("-")[0];

    // 1) Estado actual: saldo ANTES + estructura de camas
    const getJson = await cb(`getReservation?propertyID=${PROPERTY_ID}&reservationID=${grupoID}`, API_KEY);
    if (!getJson.success) {
      return res.status(200).json({ success: false, step: "getReservation", error: getJson.message || "No se pudo leer la reserva" });
    }
    const assigned = (getJson.data && getJson.data.assigned) || [];
    if (assigned.length === 0) {
      return res.status(200).json({ success: false, error: "La reserva no tiene habitaciones asignadas" });
    }

    // Cama objetivo + noches nuevas (derivadas de fechas, no del arg)
    const objetivo = assigned.find(r => String(r.subReservationID) === reservationIDArg);
    if (!objetivo) {
      return res.status(200).json({
        success: false,
        error: `No se encontro la cama ${reservationIDArg} en el grupo ${grupoID}`,
        camas_en_grupo: assigned.map(r => r.subReservationID)
      });
    }
    const oldCheckout  = objetivo.endDate;
    const nochesNuevas = enumerarNoches(oldCheckout, nuevaFecha).length;
    if (nochesNuevas <= 0) {
      return res.status(200).json({
        success: false,
        error: `La nueva fecha (${nuevaFecha}) no extiende: el checkout actual de la cama ya es ${oldCheckout}`
      });
    }

    const cargoCorrecto = Math.round(tarifaNoche * nochesNuevas * 100) / 100;
    const balanceAntes  = num(getJson.data.balance);

    // 2) Armar putReservation: extiende SOLO la objetivo (adjustPrice=true); las demas intactas.
    const params = new URLSearchParams();
    params.append("propertyID", PROPERTY_ID);
    params.append("reservationID", grupoID);
    assigned.forEach((room, i) => {
      const esObjetivo = String(room.subReservationID) === reservationIDArg;
      params.append(`rooms[${i}][subReservationID]`, room.subReservationID);
      params.append(`rooms[${i}][roomTypeID]`, room.roomTypeID);
      if (room.roomID) params.append(`rooms[${i}][roomID]`, room.roomID);
      params.append(`rooms[${i}][checkinDate]`, room.startDate);
      params.append(`rooms[${i}][checkoutDate]`, esObjetivo ? nuevaFecha : room.endDate);
      params.append(`rooms[${i}][adults]`, room.adults != null ? room.adults : 1);
      params.append(`rooms[${i}][children]`, room.children != null ? room.children : 0);
      params.append(`rooms[${i}][adjustPrice]`, esObjetivo ? "true" : "false");
    });

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        grupo: grupoID,
        objetivo: reservationIDArg,
        old_checkout: oldCheckout,
        nueva_fecha_checkout: nuevaFecha,
        noches_extra: nochesNuevas,
        tarifa_noche: tarifaNoche,
        cargo_correcto: cargoCorrecto,
        balance_antes: balanceAntes,
        nota: "dryRun no escribe; el ajuste exacto se calcula tras el putReservation real",
        body_preview: params.toString()
      });
    }

    // 3) Extender (adjustPrice recalcula). Esto SI funciona (sin error de day rates).
    const putJson = await cb("putReservation", API_KEY, params.toString());
    if (!putJson.success) {
      return res.status(200).json({
        success: false, step: "putReservation",
        error: putJson.message || "putReservation fallo",
        body_preview: params.toString()
      });
    }

    // 4) Saldo DESPUES
    const getJson2 = await cb(`getReservation?propertyID=${PROPERTY_ID}&reservationID=${grupoID}`, API_KEY);
    const balanceDespues = num(getJson2.data && getJson2.data.balance, NaN);
    if (isNaN(balanceDespues)) {
      return res.status(200).json({
        success: false, step: "getReservation_post",
        error: "Extension hecha, pero no pude releer el saldo para calcular el ajuste. Revisa el folio manualmente.",
        balance_antes: balanceAntes, cargo_correcto: cargoCorrecto
      });
    }

    // 5) Ajuste: queremos cambio neto == cargoCorrecto.
    // Convencion Cloudbeds postAdjustment: amount POSITIVO descuenta, NEGATIVO agrega cargo.
    // => new_balance = balanceDespues - amount  =>  amount = balanceDespues - (balanceAntes + cargoCorrecto)
    const amountAjuste = Math.round((balanceDespues - balanceAntes - cargoCorrecto) * 100) / 100;

    let ajusteFolio = null;
    if (Math.abs(amountAjuste) >= 0.01) {
      const adjParams = new URLSearchParams();
      adjParams.append("propertyID", PROPERTY_ID);
      adjParams.append("reservationID", grupoID);
      adjParams.append("amount", String(amountAjuste));
      adjParams.append("description", `Ajuste extension: ${nochesNuevas} noche(s) a ${tarifaNoche} MXN`);

      const adjJson = await cbPost("postAdjustment", API_KEY, adjParams.toString());
      if (!adjJson.success) {
        // La extension ya quedo, pero el folio tiene el cobro de adjustPrice sin corregir. Avisar claro.
        return res.status(200).json({
          success: false, step: "postAdjustment",
          error: `Extension hecha, pero no pude corregir el folio: ${adjJson.message || "postAdjustment fallo"}`,
          balance_antes: balanceAntes, balance_despues: balanceDespues,
          cargo_correcto: cargoCorrecto, amount_intentado: amountAjuste
        });
      }
      ajusteFolio = { aplicado: true, amount: amountAjuste, motivo: amountAjuste > 0 ? "descuento (Cloudbeds cobro de mas por re-tarifado)" : "cargo extra (Cloudbeds cobro de menos)" };
    }

    return res.status(200).json({
      success: true,
      nueva_fecha_checkout: nuevaFecha,
      total_adicional: cargoCorrecto,
      moneda: "MXN",
      noches_extra: nochesNuevas,
      camas_preservadas: assigned.length,
      ajuste_folio: ajusteFolio, // null si no hizo falta
      mensaje: `Listo, extendi tu cama hasta el ${nuevaFecha}. Total adicional: $${cargoCorrecto} MXN.`
    });

  } catch (e) {
    return res.status(500).json({ success: false, error: String((e && e.message) || e) });
  }
}

// ---------- helpers ----------

// GET (lectura) o PUT (escritura con body)
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

// POST (para postAdjustment)
async function cbPost(method, apiKey, body) {
  const r = await fetch(`${API_BASE}/${method}`, {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
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
