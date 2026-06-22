// ============================================================================
// IAN Concierge — Extender estadía (grupos seguros)
// Vercel serverless function:  /api/extender-estadia
// ----------------------------------------------------------------------------
// Por qué existe: putReservation REEMPLAZA toda la lista de habitaciones.
// Si mandás 1 cama, borra las demás. Esta función lee TODAS las camas del
// grupo y reconstruye el array completo, cambiando SOLO la cama objetivo.
//
// SEGURIDAD: incluye modo dry-run (?dryRun=true) que arma el body y lo
// devuelve SIN ejecutar el PUT. Probá siempre en dry-run antes de escribir.
//
// Setear en Vercel (Environment Variables):
//   CLOUDBEDS_API_KEY = cbat_...   (la key de la propiedad)
//   PROPERTY_ID       = 195814
// ============================================================================

const API_BASE = "https://hotels.cloudbeds.com/api/v1.2";

export default async function handler(req, res) {
  const API_KEY = process.env.CLOUDBEDS_API_KEY;
  const PROPERTY_ID = process.env.PROPERTY_ID || "195814";

  try {
    if (!API_KEY) {
      return res.status(500).json({ success: false, error: "Falta CLOUDBEDS_API_KEY en las env vars de Vercel" });
    }

    // Acepta datos por POST (body) o GET (query). Vapi manda POST.
    const p = (req.method === "POST" && req.body) ? req.body : (req.query || {});
    const reservationIDArg = String(p.reservationID || "").trim();   // subID, ej "6317754262288-14"
    const nuevaFecha       = String(p.nueva_fecha_checkout || "").trim(); // "YYYY-MM-DD"
    const dryRun           = String(p.dryRun || "") === "true";

    if (!reservationIDArg || !nuevaFecha) {
      return res.status(400).json({ success: false, error: "Faltan reservationID o nueva_fecha_checkout" });
    }

    // El grupo es el prefijo antes del guion. Para individuales no hay guion → mismo valor.
    const grupoID = reservationIDArg.split("-")[0];

    // 1) Leer TODAS las camas del grupo
    const getJson = await cb(`getReservation?propertyID=${PROPERTY_ID}&reservationID=${grupoID}`, API_KEY);
    if (!getJson.success) {
      return res.status(200).json({ success: false, step: "getReservation", error: getJson.message || "No se pudo leer la reserva" });
    }
    const assigned = (getJson.data && getJson.data.assigned) || [];
    if (assigned.length === 0) {
      return res.status(200).json({ success: false, error: "La reserva no tiene habitaciones asignadas" });
    }

    // 2) Reconstruir el array COMPLETO. Solo la cama objetivo cambia checkout + adjustPrice.
    const params = new URLSearchParams();
    params.append("propertyID", PROPERTY_ID);
    params.append("reservationID", grupoID);

    let objetivoOK = false;
    assigned.forEach((room, i) => {
      const esObjetivo = String(room.subReservationID) === reservationIDArg;
      if (esObjetivo) objetivoOK = true;
      params.append(`rooms[${i}][subReservationID]`, room.subReservationID);
      params.append(`rooms[${i}][roomTypeID]`, room.roomTypeID);
      if (room.roomID) params.append(`rooms[${i}][roomID]`, room.roomID); // preserva la cama física
      params.append(`rooms[${i}][checkinDate]`, room.startDate);
      params.append(`rooms[${i}][checkoutDate]`, esObjetivo ? nuevaFecha : room.endDate);
      params.append(`rooms[${i}][adults]`, room.adults != null ? room.adults : 1);
      params.append(`rooms[${i}][children]`, room.children != null ? room.children : 0);
      params.append(`rooms[${i}][adjustPrice]`, esObjetivo ? "true" : "false"); // solo recalcula la extendida
    });

    if (!objetivoOK) {
      return res.status(200).json({
        success: false,
        error:
