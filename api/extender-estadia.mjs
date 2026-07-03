// /api/extender-estadia.mjs — v2 "a prueba de day rates"
// Patrón: PUT solo con fechas (adjustPrice:true, SIN roomRate) → delta de saldo → postAdjustment
// Igual que extender-otro-cuarto.mjs. El PUT nunca manda tarifas diarias,
// por lo que el error "Number of days not equals to number of day rates" no puede ocurrir.

const CB = "https://api.cloudbeds.com/api/v1.2";
const PROPERTY_ID = "195814";
const API_KEY = process.env.CLOUDBEDS_API_KEY;

// ---------- utilidades de fecha (UTC-seguras, formato YYYY-MM-DD) ----------
const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const aUTC = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const nochesEntre = (a, b) => Math.round((aUTC(b) - aUTC(a)) / 86400000);

// Serializa objetos/arreglos anidados en notación de corchetes (rooms[0][endDate]=...),
// que es lo que exige la API v1.2 form-urlencoded. NO mandar JSON como texto.
function aFormData(obj, prefijo = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const clave = prefijo ? `${prefijo}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === "object") aFormData(v, clave, out);
    else out.append(clave, String(v));
  }
  return out;
}

async function cb(metodo, endpoint, params) {
  const opts = { method: metodo, headers: { Authorization: `Bearer ${API_KEY}` } };
  let url = `${CB}/${endpoint}`;
  if (metodo === "GET") {
    url += "?" + new URLSearchParams({ propertyID: PROPERTY_ID, ...params });
  } else {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = aFormData({ propertyID: PROPERTY_ID, ...params });
  }
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  return j;
}

export default async function handler(req, res) {
  try {
    const { reservationID, nueva_fecha_checkout, tarifa_noche, dry_run } = req.query;
    const esDryRun = dry_run === "true" || dry_run === "1";

    // ---------- 1. Validaciones de entrada (fallar rápido y claro) ----------
    if (!reservationID || !esFecha(nueva_fecha_checkout)) {
      return res.status(200).json({
        success: false,
        result: "Datos incompletos: se requiere reservationID y nueva_fecha_checkout en formato YYYY-MM-DD.",
      });
    }
    const tarifa = parseFloat(tarifa_noche);
    if (!isFinite(tarifa) || tarifa <= 0) {
      return res.status(200).json({
        success: false,
        result: "tarifa_noche inválida. Debe ser la tarifa POR NOCHE (número mayor a 0).",
      });
    }

    // ---------- 2. Leer la reservación actual ----------
    const resv = await cb("GET", "getReservation", { reservationID });
    if (!resv.success || !resv.data) {
      return res.status(200).json({
        success: false,
        result: `No encontré la reservación ${reservationID} en Cloudbeds.`,
      });
    }
    const d = resv.data;
    const checkoutActual = d.endDate; // checkout general de la reservación
    const saldoAntes = parseFloat(d.balance ?? 0);

    if (!esFecha(checkoutActual)) {
      return res.status(200).json({ success: false, result: "La reservación no tiene fecha de checkout válida." });
    }
    const nochesExtra = nochesEntre(checkoutActual, nueva_fecha_checkout);
    if (nochesExtra <= 0) {
      return res.status(200).json({
        success: false,
        result: `La nueva fecha (${nueva_fecha_checkout}) no es posterior al checkout actual (${checkoutActual}).`,
      });
    }

    // ---------- 3. Reconstruir el arreglo COMPLETO de camas/cuartos ----------
    // Regla ya conocida: si omites camas en putReservation, Cloudbeds las elimina.
    // Solo extendemos las camas cuyo checkout coincide con el checkout general;
    // las de rangos distintos (estadía dividida) se reenvían con sus fechas intactas.
    const asignados = Array.isArray(d.assigned) ? d.assigned : [];
    const sinAsignar = Array.isArray(d.unassigned) ? d.unassigned : [];
    const todas = [...asignados, ...sinAsignar];
    if (todas.length === 0) {
      return res.status(200).json({ success: false, result: "La reservación no tiene cuartos/camas asignados." });
    }

    const rooms = todas.map((c) => {
      const extiende = c.endDate === checkoutActual;
      const salida = extiende ? nueva_fecha_checkout : c.endDate;
      const room = {
        roomTypeID: c.roomTypeID,
        quantity: 1,
        // Cloudbeds v1.2 pide checkinDate/checkoutDate dentro de rooms[];
        // se mandan también startDate/endDate por compatibilidad (los extras se ignoran).
        checkinDate: c.startDate,
        checkoutDate: salida,
        startDate: c.startDate,
        endDate: salida,
      };
      if (c.roomID) room.roomID = c.roomID;
      if (c.subReservationID) room.subReservationID = c.subReservationID; // ID a nivel de cama (fix v3.5.2)
      return room;
      // OJO: NO se incluye roomRate ni tarifas diarias. Nunca.
    });

    // ---------- 3.5 MODO DRY RUN: muestra lo que se enviaría, sin escribir nada ----------
    if (esDryRun) {
      const camasQueSeExtienden = todas.filter((c) => c.endDate === checkoutActual).length;
      return res.status(200).json({
        success: true,
        dry_run: true,
        result: `DRY RUN: se extenderían ${camasQueSeExtienden} cama(s) de ${checkoutActual} a ${nueva_fecha_checkout} (${nochesExtra} noche(s) extra, cargo esperado $${(tarifa * nochesExtra * camasQueSeExtienden).toFixed(2)}). NO se modificó nada.`,
        payload_put_que_se_enviaria: {
          reservationID,
          rooms,
          adjustPrice: "true",
        },
        saldo_actual: saldoAntes,
        nota: "Verifica que rooms tenga TODAS las camas y que solo cambie endDate en las que corresponde.",
      });
    }

    // ---------- 4. PUT solo con fechas + adjustPrice ----------
    // Arreglos hermanos adults/children, mismo índice que rooms (patrón v1.2).
    // Se toma la ocupación real de cada cama; si no viene, 1 adulto / 0 niños.
    const adults = todas.map((c) => ({
      roomTypeID: c.roomTypeID,
      quantity: parseInt(c.adults ?? d.adults ?? 1, 10) || 1,
    }));
    const children = todas.map((c) => ({
      roomTypeID: c.roomTypeID,
      quantity: parseInt(c.children ?? d.children ?? 0, 10) || 0,
    }));
    // También por cuarto, por si esta propiedad valida ahí:
    rooms.forEach((r, i) => {
      r.adults = adults[i].quantity;
      r.children = children[i].quantity;
    });

    const put = await cb("PUT", "putReservation", {
      reservationID,
      rooms, // se serializa como rooms[0][campo]=valor (notación de corchetes)
      adults,
      children,
      adjustPrice: "true",
    });
    if (!put.success) {
      return res.status(200).json({
        success: false,
        result: `Cloudbeds rechazó la extensión: ${put.message || JSON.stringify(put)}. No se modificó la reservación.`,
      });
    }

    // ---------- 5. Fijar el precio exacto con postAdjustment (delta de saldo) ----------
    const camasExtendidas = rooms.filter((r) => r.endDate === nueva_fecha_checkout && todas.find(
      (c) => (c.subReservationID || c.roomID) === (r.subReservationID || r.roomID) && c.endDate === checkoutActual
    )).length || 1;

    const cargoEsperado = +(tarifa * nochesExtra * camasExtendidas).toFixed(2);

    const resv2 = await cb("GET", "getReservation", { reservationID });
    const saldoDespues = parseFloat(resv2?.data?.balance ?? saldoAntes);
    const cargoAplicado = +(saldoDespues - saldoAntes).toFixed(2);
    const delta = +(cargoEsperado - cargoAplicado).toFixed(2);

    let ajuste = null;
    if (Math.abs(delta) >= 0.5) {
      ajuste = await cb("POST", "postAdjustment", {
        reservationID,
        type: "rate",
        amount: String(delta),
        notes: `Ajuste extensión IAN: ${nochesExtra} noche(s) x $${tarifa} (checkout ${checkoutActual} → ${nueva_fecha_checkout})`,
      });
    }

    return res.status(200).json({
      success: true,
      result: `Extensión confirmada. Nuevo checkout: ${nueva_fecha_checkout}. Noches extra: ${nochesExtra}. Cargo total: $${cargoEsperado} MXN.`,
      detalle: {
        checkout_anterior: checkoutActual,
        checkout_nuevo: nueva_fecha_checkout,
        noches_extra: nochesExtra,
        cargo_esperado: cargoEsperado,
        cargo_aplicado_por_cloudbeds: cargoAplicado,
        ajuste_aplicado: Math.abs(delta) >= 0.5 ? delta : 0,
        ajuste_ok: ajuste ? !!ajuste.success : true,
      },
    });
  } catch (e) {
    return res.status(200).json({
      success: false,
      result: `Error interno al extender: ${e.message}. La reservación pudo no haberse modificado; verificar en Cloudbeds.`,
    });
  }
}
