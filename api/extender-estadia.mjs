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
    const dryRun           = String(p.dryRun || "") === "true";
    // Estos ya venian en el payload de Make pero no se usaban:
    const nochesExtra      = p.noches_extra != null ? Number(p.noches_extra) : null;
    const tarifaNoche      = p.tarifa_noche != null ? Number(p.tarifa_noche) : null;

    if (!reservationIDArg || !nuevaFecha) {
      return res.status(400).json({ success: false, error: "Faltan reservationID o nueva_fecha_checkout" });
    }

    const grupoID = reservationIDArg.split("-")[0];

    const getJson = await cb(`getReservation?propertyID=${PROPERTY_ID}&reservationID=${grupoID}`, API_KEY);
    if (!getJson.success) {
      return res.status(200).json({ success: false, step: "getReservation", error: getJson.message || "No se pudo leer la reserva" });
    }
    const assigned = (getJson.data && getJson.data.assigned) || [];
    if (assigned.length === 0) {
      return res.status(200).json({ success: false, error: "La reserva no tiene habitaciones asignadas" });
    }

    const targetRoom = assigned.find(r => String(r.subReservationID) === reservationIDArg);

    const params = new URLSearchParams();
    params.append("propertyID", PROPERTY_ID);
    params.append("reservationID", grupoID);

    let objetivoOK = false;
    assigned.forEach((room, i) => {
      const esObjetivo = String(room.subReservationID) === reservationIDArg;
      if (esObjetivo) objetivoOK = true;
      params.append(`rooms[${i}][subReservationID]`, room.subReservationID);
      params.append(`rooms[${i}][roomTypeID]`, room.roomTypeID);
      if (room.roomID) params.append(`rooms[${i}][roomID]`, room.roomID);
      params.append(`rooms[${i}][checkinDate]`, room.startDate);
      params.append(`rooms[${i}][checkoutDate]`, esObjetivo ? nuevaFecha : room.endDate);
      params.append(`rooms[${i}][adults]`, room.adults != null ? room.adults : 1);
      params.append(`rooms[${i}][children]`, room.children != null ? room.children : 0);
      // CAMBIO CLAVE: adjustPrice:true SOLO en la cama que se extiende.
      // Esto le pide a Cloudbeds que calcule en vivo la tarifa de la(s) noche(s)
      // nueva(s) usando su tarifa base actual (evita el error "Number of days
      // not equals to number of day rates", que ocurre cuando cambias el rango
      // de fechas pero Cloudbeds no tiene tarifa para la noche extra).
      // Las camas que NO se tocan van con adjustPrice:false para no recalcular
      // nada de lo que ya estaba correcto.
      params.append(`rooms[${i}][adjustPrice]`, esObjetivo ? "true" : "false");
    });

    if (!objetivoOK) {
      return res.status(200).json({
        success: false,
        error: `No se encontró la cama ${reservationIDArg} en el grupo ${grupoID}`,
        camas_en_grupo: assigned.map(r => r.subReservationID)
      });
    }

    const resumenCamas = assigned.map((r, i) => ({
      i,
      sub: r.subReservationID,
      cuarto: r.roomName || r.roomID,
      checkout: String(r.subReservationID) === reservationIDArg ? `${nuevaFecha} <-- EXTENDIDA` : r.endDate
    }));

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        grupo: grupoID,
        objetivo: reservationIDArg,
        total_camas: assigned.length,
        camas: resumenCamas,
        body_preview: params.toString()
      });
    }

    const balanceAntes = num(getJson.data.balance);
    const putJson = await cb("putReservation", API_KEY, params.toString());
    if (!putJson.success) {
      const rawError = putJson.message || "putReservation fallo";
      // Este es el error puntual que da Cloudbeds cuando no encuentra tarifa
      // cargada (Base Rate) para alguna de las noches nuevas que se están
      // agregando. adjustPrice:true no alcanza a resolverlo si Cloudbeds no
      // tiene con qué calcular el precio de esa noche.
      const esErrorDeTarifas = /day rate/i.test(rawError);

      let fechasSinTarifa = null;
      if (esErrorDeTarifas && targetRoom) {
        fechasSinTarifa = await diagnosticarTarifasFaltantes({
          apiKey: API_KEY,
          propertyID: PROPERTY_ID,
          roomTypeID: targetRoom.roomTypeID,
          checkoutViejo: targetRoom.endDate,
          checkoutNuevo: nuevaFecha
        });
      }

      return res.status(200).json({
        success: false, step: "putReservation",
        error: rawError,
        ...(esErrorDeTarifas ? {
          posible_causa: "Cloudbeds no encontró tarifa cargada (Base Rate) para una o más de las noches nuevas. Revisa Rates > Base Rates / Availability Matrix para esas fechas y ese tipo de cuarto."
        } : {}),
        ...(fechasSinTarifa && fechasSinTarifa.length ? { fechas_sin_tarifa: fechasSinTarifa } : {}),
        camas: resumenCamas, body_preview: params.toString()
      });
    }

    // Si Cloudbeds no cobro la tarifa que quieres (porque uso su tarifa base
    // en vez de tarifa_noche), forzamos el ajuste manualmente aqui.
    // Comenta este bloque si prefieres dejar que Cloudbeds cobre su tarifa base tal cual.
    if (tarifaNoche != null && nochesExtra != null && nochesExtra > 0) {
      const montoEsperado = Math.round(tarifaNoche * nochesExtra * 100) / 100;
      // postAdjustment agrega un cargo/ajuste a la reserva por el monto indicado.
      // Ajusta el nombre de los parametros segun lo que confirme soporte de Cloudbeds
      // (reservationID, subReservationID/roomID, amount, description, etc.)
      // Dejamos esto listo pero comentado hasta confirmar el contrato exacto:
      /*
      const adjParams = new URLSearchParams();
      adjParams.append("propertyID", PROPERTY_ID);
      adjParams.append("reservationID", grupoID);
      adjParams.append("subReservationID", reservationIDArg);
      adjParams.append("amount", montoEsperado);
      adjParams.append("description", `Extensión de estadía: ${nochesExtra} noche(s) x $${tarifaNoche}`);
      await cb("postAdjustment", API_KEY, adjParams.toString());
      */
    }

    const getJson2 = await cb(`getReservation?propertyID=${PROPERTY_ID}&reservationID=${grupoID}`, API_KEY);
    const balanceDespues = num(getJson2.data && getJson2.data.balance, balanceAntes);
    const totalAdicional = Math.round((balanceDespues - balanceAntes) * 100) / 100;

    return res.status(200).json({
      success: true,
      nueva_fecha_checkout: nuevaFecha,
      total_adicional: totalAdicional,
      moneda: "MXN",
      camas_preservadas: assigned.length,
      mensaje: `Listo, extendi tu cama hasta el ${nuevaFecha}. Total adicional: $${totalAdicional} MXN.`
    });

  } catch (e) {
    return res.status(500).json({ success: false, error: String((e && e.message) || e) });
  }
}

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

// Devuelve la lista de noches (una fecha por noche, formato yyyy-mm-dd) entre
// startStr (inclusive) y endStr (exclusive). Ej: ("2026-07-04","2026-07-06")
// -> ["2026-07-04","2026-07-05"]
function datesBetween(startStr, endStr) {
  const dates = [];
  let d = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T00:00:00Z`);
  while (d < end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

// Diagnóstico best-effort: intenta detectar cuáles de las noches nuevas no
// tienen tarifa/disponibilidad cargada en Cloudbeds (getRatePlans). Es
// deliberadamente defensivo: si la forma de la respuesta no es la esperada,
// o cualquier cosa falla, regresa null en vez de arriesgar un diagnóstico
// incorrecto o tumbar la respuesta principal.
async function diagnosticarTarifasFaltantes({ apiKey, propertyID, roomTypeID, checkoutViejo, checkoutNuevo }) {
  try {
    if (!checkoutViejo || !checkoutNuevo || checkoutNuevo <= checkoutViejo || !roomTypeID) return null;

    const nochesNuevas = datesBetween(checkoutViejo, checkoutNuevo);
    if (nochesNuevas.length === 0) return null;

    const json = await cb(
      `getRatePlans?propertyID=${propertyID}&roomTypeID=${roomTypeID}&startDate=${checkoutViejo}&endDate=${checkoutNuevo}&detailedRates=true`,
      apiKey
    );
    if (!json.success || !Array.isArray(json.data)) return null;

    // Junta todas las fechas que sí tienen tarifa+disponibilidad en
    // cualquiera de los rate plans devueltos (base rate u otros).
    const fechasConTarifa = new Set();
    for (const plan of json.data) {
      const detalle = plan.roomRate || plan.rateDaily || plan.detailedRates || [];
      if (!Array.isArray(detalle)) continue;
      for (const d of detalle) {
        const fecha = d.date || d.rateDate;
        const disponible = d.roomsAvailable == null || Number(d.roomsAvailable) > 0;
        const tieneTarifa = d.rate != null && Number(d.rate) > 0;
        if (fecha && disponible && tieneTarifa) fechasConTarifa.add(fecha);
      }
    }

    // Si no logramos interpretar nada de la respuesta, no arriesgamos el diagnóstico.
    if (fechasConTarifa.size === 0 && json.data.length === 0) return null;

    return nochesNuevas.filter(f => !fechasConTarifa.has(f));
  } catch (e) {
    return null;
  }
}
