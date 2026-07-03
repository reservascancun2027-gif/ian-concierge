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
      // CAMBIO CLAVE: ya no mandamos adjustPrice:true sin roomRates.
      // Dejamos que Cloudbeds cobre la(s) noche(s) nueva(s) a su tarifa base actual.
      // Si necesitas forzar un precio distinto (tarifa_noche), se ajusta despues
      // con /postAdjustment (ver bloque mas abajo).
      params.append(`rooms[${i}][adjustPrice]`, "false");
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
      return res.status(200).json({
        success: false, step: "putReservation",
        error: putJson.message || "putReservation fallo",
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
