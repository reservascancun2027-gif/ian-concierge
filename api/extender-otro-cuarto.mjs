const API_BASE = "https://hotels.cloudbeds.com/api/v1.2";

// EXTENDER EN OTRO CUARTO (via Vercel) — hermana de extender-estadia.mjs
//
// Mismo patron probado que mismo-cuarto: PUT (recalcula) -> medir delta de saldo ->
// postAdjustment para clavar el cargo neto EXACTO. putReservation no acepta escritura
// de tarifas por dia (probado: "Number of days not equals to number of day rates"),
// por eso el ajuste de saldo es la unica via que sostiene el precio preferencial.
//
// Diferencias clave vs mismo cuarto:
//   - Las camas actuales se quedan INTACTAS (adjustPrice=false): no se alargan.
//   - Se AGREGA un cuarto nuevo [checkout_actual -> nueva_fecha] (adjustPrice=true).
//   - La tarifa NO se recibe del agente: se lee (publica) de getAvailableRoomTypes.
//   - Reconstruye TODAS las camas (anti-borrado del arreglo declarativo, multi-cama safe).
//
// Por que el ajuste es robusto sin importar si adjustPrice=false preserva el cuarto viejo:
//   - Si Cloudbeds preserva el preferencial -> amountAjuste = 0 (no toca el folio).
//   - Si lo re-tarifa a publica         -> amountAjuste repone la diferencia.
//   En ambos casos el saldo final = balanceAntes + (tarifa_noche x noches).
//
// Recibe (POST body o query): reservationID, roomTypeID, nueva_fecha_checkout. Opcional dryRun.
// Env vars: CLOUDBEDS_API_KEY (obligatoria), PROPERTY_ID (opcional, default 195814).

export default async function handler(req, res) {
  const API_KEY = process.env.CLOUDBEDS_API_KEY;
  const PROPERTY_ID = process.env.PROPERTY_ID || "195814";

  try {
    if (!API_KEY) {
      return res.status(500).json({ success: false, error: "Falta CLOUDBEDS_API_KEY en las env vars de Vercel" });
    }

    const p = (req.method === "POST" && req.body) ? req.body : (req.query || {});
    const reservationIDArg = String(p.reservationID || "").trim();
    const roomTypeIDArg    = String(p.roomTypeID || "").trim();
    const nuevaFecha       = String(p.nueva_fecha_checkout || "").trim();
    const dryRun           = String(p.dryRun || "") === "true";

    if (!reservationIDArg || !roomTypeIDArg || !nuevaFecha) {
      return res.status(400).json({ success: false, error: "Faltan reservationID, roomTypeID o nueva_fecha_checkout" });
    }

    // Acepta grupo ("123") o cama ("123-1"): siempre operamos sobre el grupo
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
    const balanceAntes = num(getJson.data.balance);

    // GUARD DE STATUS: no operar sobre reservas en estado terminal.
    // Cloudbeds usa snake_case en la API (confirmed, checked_in, checked_out, canceled, no_show).
    // Blocklist de los terminales; normalizamos por si el campo llega con mayusculas/espacios/guiones.
    // (Se bloquea lo que NO debe extenderse; confirmed/checked_in/pending pasan. Si quieres
    //  allowlist estricta -solo confirmed y checked_in-, cambia BLOQUEADOS por un ALLOWLIST.)
    const statusRaw  = String((getJson.data && getJson.data.status) || "").trim();
    const statusNorm = statusRaw.toLowerCase().replace(/[\s-]+/g, "_");
    const BLOQUEADOS = {
      checked_out: "ya hizo checkout",
      canceled:    "esta cancelada",
      cancelled:   "esta cancelada",   // grafia alterna, por si acaso
      no_show:     "quedo como no-show"
    };
    if (BLOQUEADOS[statusNorm]) {
      return res.status(200).json({
        success: false,
        step: "guard_status",
        status: statusRaw,
        error: `No puedo extender: la reserva ${grupoID} ${BLOQUEADOS[statusNorm]}.`
      });
    }

    // 2) Checkout actual = el endDate MAS TARDIO de las camas (no del sobre del grupo,
    //    para evitar el bug de zona horaria por leer fechas del envoltorio).
    //    El cuarto nuevo arranca aqui.
    const checkoutActual = assigned
      .map(r => r.endDate)
      .filter(Boolean)
      .sort()            // YYYY-MM-DD ordena cronologicamente
      .pop();

    const nochesNuevas = enumerarNoches(checkoutActual, nuevaFecha).length;
    if (nochesNuevas <= 0) {
      return res.status(200).json({
        success: false,
        error: `La nueva fecha (${nuevaFecha}) no extiende: el checkout actual ya es ${checkoutActual}`
      });
    }

    // 3) Disponibilidad + tarifa PUBLICA del cuarto nuevo, en la ventana de extension
    const rtJson = await cb(
      `getAvailableRoomTypes?propertyID=${PROPERTY_ID}&startDate=${checkoutActual}&endDate=${nuevaFecha}`,
      API_KEY
    );
    if (!rtJson.success) {
      return res.status(200).json({ success: false, step: "getAvailableRoomTypes", error: rtJson.message || "No se pudo leer disponibilidad" });
    }
    const propertyRooms = (rtJson.data && rtJson.data[0] && rtJson.data[0].propertyRooms) || [];
    const cuarto = propertyRooms.find(r => String(r.roomTypeID) === roomTypeIDArg);
    if (!cuarto) {
      return res.status(200).json({
        success: false,
        error: `El tipo de cuarto ${roomTypeIDArg} no aparece para esas fechas`,
        tipos_devueltos: propertyRooms.map(r => r.roomTypeID)
      });
    }

    // DESCARTE DEL CUARTO ACTUAL DEL HUESPED (resuelve "falta descartar current room"):
    // Si el cuarto nuevo es del MISMO tipo que una cama que el huesped desocupa, esa(s)
    // unidad(es) quedan libres para la ventana nueva. Sumarlas evita que el huesped se
    // bloquee a si mismo. Permisivo a proposito: si Cloudbeds ya las liberaba, a lo mas
    // sobreestima en 1 y el putReservation rechazaria limpio ANTES de cualquier cargo.
    const liberadasMismoTipo = assigned.filter(r => String(r.roomTypeID) === roomTypeIDArg).length;
    const disponibles = num(cuarto.roomsAvailable, 0) + liberadasMismoTipo;

    if (disponibles <= 0) {
      return res.status(200).json({
        success: false,
        disponible: false,
        cuarto_nuevo: limpiar(cuarto.roomTypeName),
        error: `No hay disponibilidad de ${limpiar(cuarto.roomTypeName)} para extender del ${checkoutActual} al ${nuevaFecha}`
      });
    }

    // Tarifa: roomRate de getAvailableRoomTypes ES el total de la ventana consultada
    // (mismo criterio que EXTENDER 1 v10, que divide roomRate entre noches para el por-noche).
    const totalVentana = num(cuarto.roomRate, NaN);
    if (!(totalVentana > 0)) {
      return res.status(200).json({ success: false, error: "El cuarto no devolvio una tarifa valida (> 0)" });
    }
    const cargoCorrecto = Math.round(totalVentana * 100) / 100;
    const tarifaNoche   = Math.round((totalVentana / nochesNuevas) * 100) / 100;

    // Ocupacion a heredar para el cuarto nuevo (mismo huesped). Default: primera cama.
    const refOcupacion = assigned[0] || {};
    const adults   = refOcupacion.adults   != null ? refOcupacion.adults   : 1;
    const children = refOcupacion.children != null ? refOcupacion.children : 0;

    // 4) Armar putReservation: camas viejas INTACTAS + cuarto nuevo como tramo extra
    const params = new URLSearchParams();
    params.append("propertyID", PROPERTY_ID);
    params.append("reservationID", grupoID);

    assigned.forEach((room, i) => {
      params.append(`rooms[${i}][subReservationID]`, room.subReservationID);
      params.append(`rooms[${i}][roomTypeID]`, room.roomTypeID);
      if (room.roomID) params.append(`rooms[${i}][roomID]`, room.roomID);
      params.append(`rooms[${i}][checkinDate]`, room.startDate);
      params.append(`rooms[${i}][checkoutDate]`, room.endDate);   // SIN cambio
      params.append(`rooms[${i}][adults]`, room.adults != null ? room.adults : 1);
      params.append(`rooms[${i}][children]`, room.children != null ? room.children : 0);
      params.append(`rooms[${i}][adjustPrice]`, "false");          // preservar precio del tramo viejo
    });

    // Cuarto nuevo (sin subReservationID: Cloudbeds lo crea). adjustPrice=true -> toma la publica.
    const nuevoIdx = assigned.length;
    params.append(`rooms[${nuevoIdx}][roomTypeID]`, roomTypeIDArg);
    params.append(`rooms[${nuevoIdx}][checkinDate]`, checkoutActual);
    params.append(`rooms[${nuevoIdx}][checkoutDate]`, nuevaFecha);
    params.append(`rooms[${nuevoIdx}][adults]`, adults);
    params.append(`rooms[${nuevoIdx}][children]`, children);
    params.append(`rooms[${nuevoIdx}][adjustPrice]`, "true");

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        grupo: grupoID,
        checkout_actual: checkoutActual,
        nueva_fecha_checkout: nuevaFecha,
        noches_extra: nochesNuevas,
        cuarto_nuevo: limpiar(cuarto.roomTypeName),
        disponibles_al_confirmar: disponibles,
        tarifa_noche: tarifaNoche,
        cargo_correcto: cargoCorrecto,
        balance_antes: balanceAntes,
        camas_preservadas: assigned.length,
        nota: "dryRun no escribe; el ajuste exacto se calcula tras el putReservation real",
        body_preview: params.toString()
      });
    }

    // 5) Extender (el cuarto nuevo se tarifica a publica; camas viejas intactas)
    const putJson = await cb("putReservation", API_KEY, params.toString());
    if (!putJson.success) {
      return res.status(200).json({
        success: false, step: "putReservation",
        error: putJson.message || "putReservation fallo",
        body_preview: params.toString()
      });
    }

    // 6) Saldo DESPUES
    const getJson2 = await cb(`getReservation?propertyID=${PROPERTY_ID}&reservationID=${grupoID}`, API_KEY);
    const balanceDespues = num(getJson2.data && getJson2.data.balance, NaN);
    if (isNaN(balanceDespues)) {
      return res.status(200).json({
        success: false, step: "getReservation_post",
        error: "Extension hecha, pero no pude releer el saldo para calcular el ajuste. Revisa el folio manualmente.",
        balance_antes: balanceAntes, cargo_correcto: cargoCorrecto
      });
    }

    // 7) Ajuste: cambio neto == cargoCorrecto (identico a mismo cuarto).
    // Convencion Cloudbeds postAdjustment: amount POSITIVO descuenta, NEGATIVO agrega cargo.
    // => amount = balanceDespues - balanceAntes - cargoCorrecto
    const amountAjuste = Math.round((balanceDespues - balanceAntes - cargoCorrecto) * 100) / 100;

    let ajusteFolio = null;
    if (Math.abs(amountAjuste) >= 0.01) {
      const adjParams = new URLSearchParams();
      adjParams.append("propertyID", PROPERTY_ID);
      adjParams.append("reservationID", grupoID);
      adjParams.append("amount", String(amountAjuste));
      adjParams.append("type", "rate"); // room rate (confirmado contra Cloudbeds)
      adjParams.append("description", `Ajuste extension otro cuarto: ${nochesNuevas} noche(s) a ${tarifaNoche} MXN`);

      const adjJson = await cbPost("postAdjustment", API_KEY, adjParams.toString());
      if (!adjJson.success) {
        // La extension ya quedo; el folio tiene el cobro sin corregir. Avisar claro.
        return res.status(200).json({
          success: false, step: "postAdjustment",
          error: `Extension hecha, pero no pude corregir el folio: ${adjJson.message || "postAdjustment fallo"}`,
          balance_antes: balanceAntes, balance_despues: balanceDespues,
          cargo_correcto: cargoCorrecto, amount_intentado: amountAjuste
        });
      }
      ajusteFolio = {
        aplicado: true,
        amount: amountAjuste,
        motivo: amountAjuste > 0 ? "descuento (Cloudbeds cobro de mas al re-tarifar)" : "cargo extra (Cloudbeds cobro de menos)"
      };
    }

    return res.status(200).json({
      success: true,
      nueva_fecha_checkout: nuevaFecha,
      checkout_anterior: checkoutActual,
      cuarto_nuevo: limpiar(cuarto.roomTypeName),
      total_adicional: cargoCorrecto,
      tarifa_noche: tarifaNoche,
      moneda: "MXN",
      noches_extra: nochesNuevas,
      camas_preservadas: assigned.length,
      ajuste_folio: ajusteFolio, // null si no hizo falta
      mensaje: `Listo, te movemos a ${limpiar(cuarto.roomTypeName)} del ${checkoutActual} al ${nuevaFecha}. Total adicional: $${cargoCorrecto} MXN ($${tarifaNoche} MXN por noche), a pagar en recepcion.`
    });

  } catch (e) {
    return res.status(500).json({ success: false, error: String((e && e.message) || e) });
  }
}

// ---------- helpers (identicos a extender-estadia.mjs salvo limpiar) ----------

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

// Quita saltos de linea de nombres de cuarto (equivalente a replace(...; newline; ) en Make)
function limpiar(s) {
  return String(s || "").replace(/[\r\n]+/g, " ").trim();
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
