const API_BASE = "https://hotels.cloudbeds.com/api/v1.2";

// EXTENDER ESTADIA MISMO CUARTO (via Vercel) — hermana de extender-otro-cuarto.mjs
//
// Mismo patron probado: PUT (recalcula) -> medir delta de saldo -> postAdjustment
// para clavar el cargo neto EXACTO. putReservation no acepta escritura de tarifas
// por dia (probado: "Number of days not equals to number of day rates"), por eso
// NUNCA se mandan tarifas en el PUT; el ajuste de saldo sostiene el precio cotizado.
//
// Formato de rooms[] calcado del archivo que ya funciona en produccion:
//   rooms[i][subReservationID|roomTypeID|roomID|checkinDate|checkoutDate|adults|children|adjustPrice]
//   * adjustPrice va DENTRO de cada cuarto (a nivel raiz Cloudbeds lo ignora y truena con day rates).
//
// Logica: alarga las camas cuyo checkout coincide con el checkout mas tardio del grupo
// (adjustPrice=true). Camas con rangos distintos (estadia dividida) van INTACTAS
// (adjustPrice=false). Reconstruye TODAS las camas (anti-borrado del arreglo declarativo).
//
// Recibe (POST body o query): reservationID, nueva_fecha_checkout, tarifa_noche (POR NOCHE, cotizada).
// Opcional: dryRun / dry_run. Env vars: CLOUDBEDS_API_KEY (obligatoria), PROPERTY_ID (default 195814).

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
    const dryRun           = String(p.dryRun || p.dry_run || "") === "true";

    if (!reservationIDArg || !/^\d{4}-\d{2}-\d{2}$/.test(nuevaFecha)) {
      return res.status(200).json({ success: false, error: "Faltan reservationID o nueva_fecha_checkout (YYYY-MM-DD)" });
    }
    if (!(tarifaNoche > 0)) {
      return res.status(200).json({ success: false, error: "tarifa_noche invalida: debe ser la tarifa POR NOCHE (> 0)" });
    }

    // Acepta grupo ("123") o cama ("123-1"): siempre operamos sobre el grupo
    const grupoID = reservationIDArg.split("-")[0];

    // 1) Estado actual: saldo ANTES + estructura de camas
    const getJson = await cb("getReservation?propertyID=" + PROPERTY_ID + "&reservationID=" + grupoID, API_KEY);
    if (!getJson.success) {
      return res.status(200).json({ success: false, step: "getReservation", error: getJson.message || "No se pudo leer la reserva" });
    }
    const assigned = (getJson.data && getJson.data.assigned) || [];
    if (assigned.length === 0) {
      return res.status(200).json({ success: false, error: "La reserva no tiene habitaciones asignadas" });
    }
    const balanceAntes = num(getJson.data.balance);

    // GUARD DE STATUS: no operar sobre reservas en estado terminal (mismo guard que otro-cuarto)
    const statusRaw  = String((getJson.data && getJson.data.status) || "").trim();
    const statusNorm = statusRaw.toLowerCase().replace(/[\s-]+/g, "_");
    const BLOQUEADOS = {
      checked_out: "ya hizo checkout",
      canceled:    "esta cancelada",
      cancelled:   "esta cancelada",
      no_show:     "quedo como no-show"
    };
    if (BLOQUEADOS[statusNorm]) {
      return res.status(200).json({
        success: false,
        step: "guard_status",
        status: statusRaw,
        error: "No puedo extender: la reserva " + grupoID + " " + BLOQUEADOS[statusNorm] + "."
      });
    }

    // 2) Checkout actual = el endDate MAS TARDIO de las camas (no del sobre del grupo,
    //    para evitar el bug de zona horaria por leer fechas del envoltorio).
    const checkoutActual = assigned
      .map(r => r.endDate)
      .filter(Boolean)
      .sort()            // YYYY-MM-DD ordena cronologicamente
      .pop();

    const nochesExtra = enumerarNoches(checkoutActual, nuevaFecha).length;
    if (nochesExtra <= 0) {
      return res.status(200).json({
        success: false,
        error: "La nueva fecha (" + nuevaFecha + ") no extiende: el checkout actual ya es " + checkoutActual
      });
    }

    // 3) Armar putReservation: TODAS las camas reconstruidas.
    //    - Camas con checkout == checkoutActual: se alargan (adjustPrice=true, Cloudbeds
    //      genera las tarifas diarias del tramo nuevo; el ajuste corrige despues).
    //    - Camas con rangos distintos (estadia dividida): INTACTAS (adjustPrice=false).
    const params = new URLSearchParams();
    params.append("propertyID", PROPERTY_ID);
    params.append("reservationID", grupoID);

    let camasExtendidas = 0;
    assigned.forEach(function (room, i) {
      const extiende = room.endDate === checkoutActual;
      if (extiende) camasExtendidas++;
      // Concatenacion simple (sin backticks): el indice [i] es OBLIGATORIO.
      // Con "rooms[]" (indice vacio) cada campo crea un elemento nuevo y Cloudbeds
      // truena con "Number of days not equals to number of day rates".
      const pfx = "rooms[" + i + "]";
      params.append(pfx + "[subReservationID]", room.subReservationID);
      params.append(pfx + "[roomTypeID]", room.roomTypeID);
      if (room.roomID) params.append(pfx + "[roomID]", room.roomID);
      params.append(pfx + "[checkinDate]", room.startDate);
      params.append(pfx + "[checkoutDate]", extiende ? nuevaFecha : room.endDate);
      params.append(pfx + "[adults]", room.adults != null ? room.adults : 1);
      params.append(pfx + "[children]", room.children != null ? room.children : 0);
      params.append(pfx + "[adjustPrice]", extiende ? "true" : "false");
    });

    // GUARD ANTI-PEGADO: si por cualquier razon el body no trae indices, abortar
    // ANTES de tocar Cloudbeds.
    if (params.toString().indexOf("rooms%5B0%5D") === -1) {
      return res.status(500).json({
        success: false,
        error: "Bug interno: el body no trae indices en rooms[]. No se llamo a Cloudbeds."
      });
    }

    const cargoCorrecto = Math.round(tarifaNoche * nochesExtra * camasExtendidas * 100) / 100;

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        grupo: grupoID,
        checkout_actual: checkoutActual,
        nueva_fecha_checkout: nuevaFecha,
        noches_extra: nochesExtra,
        camas_extendidas: camasExtendidas,
        camas_totales: assigned.length,
        tarifa_noche: tarifaNoche,
        cargo_correcto: cargoCorrecto,
        balance_antes: balanceAntes,
        nota: "dryRun no escribe; el ajuste exacto se calcula tras el putReservation real",
        body_preview: params.toString()
      });
    }

    // 4) Extender (el tramo nuevo se tarifica a publica; el ajuste lo corrige)
    const putJson = await cb("putReservation", API_KEY, params.toString());
    if (!putJson.success) {
      return res.status(200).json({
        success: false, step: "putReservation",
        error: putJson.message || "putReservation fallo",
        body_preview: params.toString()
      });
    }

    // 5) Saldo DESPUES
    const getJson2 = await cb("getReservation?propertyID=" + PROPERTY_ID + "&reservationID=" + grupoID, API_KEY);
    const balanceDespues = num(getJson2.data && getJson2.data.balance, NaN);
    if (isNaN(balanceDespues)) {
      return res.status(200).json({
        success: false, step: "getReservation_post",
        error: "Extension hecha, pero no pude releer el saldo para calcular el ajuste. Revisa el folio manualmente.",
        balance_antes: balanceAntes, cargo_correcto: cargoCorrecto
      });
    }

    // 6) Ajuste: cambio neto == cargoCorrecto (identico a otro-cuarto).
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
      adjParams.append("description", "Ajuste extension estadia: " + nochesExtra + " noche(s) a " + tarifaNoche + " MXN");

      const adjJson = await cbPost("postAdjustment", API_KEY, adjParams.toString());
      if (!adjJson.success) {
        // La extension ya quedo; el folio tiene el cobro sin corregir. Avisar claro.
        return res.status(200).json({
          success: false, step: "postAdjustment",
          error: "Extension hecha, pero no pude corregir el folio: " + (adjJson.message || "postAdjustment fallo"),
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
      noches_extra: nochesExtra,
      camas_extendidas: camasExtendidas,
      camas_totales: assigned.length,
      tarifa_noche: tarifaNoche,
      total_adicional: cargoCorrecto,
      moneda: "MXN",
      ajuste_folio: ajusteFolio, // null si no hizo falta
      mensaje: "Listo, extendimos tu estadia al " + nuevaFecha + ". Total adicional: $" + cargoCorrecto + " MXN ($" + tarifaNoche + " MXN por noche), a pagar en recepcion."
    });

  } catch (e) {
    return res.status(500).json({ success: false, error: String((e && e.message) || e) });
  }
}

// ---------- helpers (identicos a extender-otro-cuarto.mjs) ----------

// GET (lectura) o PUT (escritura con body)
async function cb(pathOrMethod, apiKey, body) {
  const isWrite = !!body;
  const url = API_BASE + "/" + pathOrMethod;
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
  const r = await fetch(API_BASE + "/" + method, {
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
  const d   = new Date(checkin + "T00:00:00Z");
  const fin = new Date(checkout + "T00:00:00Z");
  while (d < fin) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
