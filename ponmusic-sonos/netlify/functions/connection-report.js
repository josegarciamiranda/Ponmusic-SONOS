/* connection-report.js — cálculo de uptime/desconexiones para el informe de Monitoreo.
   Se probó a fondo con node antes de conectarlo al endpoint (ver tests al final del archivo,
   se pueden correr con: node connection-report.js).
*/

const MIN_DOWNTIME_MS = 60000; // se ignoran cortes de menos de 1 minuto (ruido de red)

/* Convierte una fecha+hora "de pared" (la que ve el dueño de la tienda en su reloj,
   ej. '2026-09-21' '10:00') en el instante UTC real que representa, según el huso
   horario de ESA tienda. Usa el truco estándar de doble formatToParts, que resuelve
   solo el desfase correcto para esa fecha puntual — por eso funciona bien incluso con
   husos horarios que cambian de horario de verano en ciertas fechas del año (USA),
   sin necesitar tablas de horario de verano a mano ni dependencias externas.
   Si timeZone no es válido o viene vacío, cae de vuelta a UTC (comportamiento anterior). */
function zonedWallClockToUtc(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [hh, mm, ss] = timeStr.split(':').map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d, hh, mm, ss || 0));
  if (!timeZone) return guess;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(guess).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const diff = asIfUtc - guess.getTime();
    return new Date(guess.getTime() - diff);
  } catch (e) {
    return guess; // huso horario desconocido/mal escrito: mejor UTC que romper el informe
  }
}

/* ¿Qué franja de "operación" tiene esta tienda en un día dado?
   oper_start/oper_end en formato 'HH:MM', interpretados en el huso horario de LA
   TIENDA (timezone, ej. 'America/Lima', 'America/Costa_Rica', 'America/New_York').
   Si vienen null, es 24 horas (también en el huso horario de la tienda). */
function dayOperatingWindow(dateStr, operStart, operEnd, timeZone) {
  if (!operStart || !operEnd) {
    return [
      zonedWallClockToUtc(dateStr, '00:00:00', timeZone),
      zonedWallClockToUtc(dateStr, '23:59:59', timeZone),
    ];
  }
  return [
    zonedWallClockToUtc(dateStr, operStart + ':00', timeZone),
    zonedWallClockToUtc(dateStr, operEnd + ':00', timeZone),
  ];
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

/* Recorta un intervalo [start,end] a solo la parte que cae dentro del horario de
   operación de la tienda, día por día (un intervalo puede cruzar varios días). */
function clipIntervalToOperatingHours(start, end, operStart, operEnd, timeZone) {
  const clipped = [];
  let cursorDate = isoDate(start);
  const endDate = isoDate(end);
  let guard = 0;
  while (cursorDate <= endDate && guard < 400) {
    guard++;
    const [winStart, winEnd] = dayOperatingWindow(cursorDate, operStart, operEnd, timeZone);
    const segStart = start > winStart ? start : winStart;
    const segEnd = end < winEnd ? end : winEnd;
    if (segStart < segEnd) clipped.push([segStart, segEnd]);
    const next = new Date(cursorDate + 'T00:00:00.000Z');
    next.setUTCDate(next.getUTCDate() + 1);
    cursorDate = isoDate(next);
  }
  return clipped;
}

/* events: [{event_type:'connect'|'disconnect', event_time: isoString}, ...] — de una sola tienda,
   YA ordenados por event_time ascendente. from/to: Date. isCurrentlyDown: si ahora mismo (o al
   cierre del período) está caída sin un evento de 'connect' que lo cierre todavía. */
function computeStoreUptime(events, from, to, operStart, operEnd, isCurrentlyDown, timeZone, lastSeen) {
  const downIntervals = [];
  let downSince = null;

  // Estado al empezar el período: si el primer evento visible es 'connect', asumimos que
  // ya venía caída desde antes de 'from' (más seguro que asumir que estaba arriba sin pruebas).
  if (events.length === 0) {
    if (isCurrentlyDown) {
      const downFrom = (lastSeen && lastSeen > from && lastSeen < to) ? lastSeen : from;
      downIntervals.push([downFrom, to]);
    }
  } else {
    if (events[0].event_type === 'connect') downSince = from;
    events.forEach(function (ev) {
      const t = new Date(ev.event_time);
      const clamped = t < from ? from : (t > to ? to : t);
      if (ev.event_type === 'disconnect') {
        downSince = clamped;
      } else if (ev.event_type === 'connect') {
        if (downSince) { downIntervals.push([downSince, clamped]); downSince = null; }
      }
    });
    if (downSince) {
      downIntervals.push([downSince, to]); // seguía caída al cierre del período
    } else if (isCurrentlyDown) {
      // Según el historial ya cerrado, la tienda venía "conectada" — pero AHORA MISMO
      // está caída y ese corte todavía no se anotó (eso recién se registra cuando vuelva
      // a conectar). Usamos el último aviso de vida conocido como estimado de cuándo
      // empezó a caerse, para que el % de hoy sí refleje la realidad de este momento.
      const downFrom = (lastSeen && lastSeen > from && lastSeen < to) ? lastSeen : from;
      downIntervals.push([downFrom, to]);
    }
  }

  // Recortar cada intervalo caído al horario de operación, e ignorar los menores a 1 minuto.
  let downtimeMs = 0, longestMs = 0, disconnections = 0;
  downIntervals.forEach(function ([s, e]) {
    const segs = clipIntervalToOperatingHours(s, e, operStart, operEnd, timeZone);
    segs.forEach(function ([segS, segE]) {
      const ms = segE.getTime() - segS.getTime();
      if (ms < MIN_DOWNTIME_MS) return; // ruido, se ignora
      downtimeMs += ms;
      if (ms > longestMs) longestMs = ms;
      disconnections++;
    });
  });

  // Minutos "de operación" totales del período (para el % de uptime).
  let operatingMs = 0;
  let cursorDate = isoDate(from), endDate = isoDate(to), guard = 0;
  while (cursorDate <= endDate && guard < 400) {
    guard++;
    const [winStart, winEnd] = dayOperatingWindow(cursorDate, operStart, operEnd, timeZone);
    const segStart = from > winStart ? from : winStart;
    const segEnd = to < winEnd ? to : winEnd;
    if (segStart < segEnd) operatingMs += segEnd.getTime() - segStart.getTime();
    const next = new Date(cursorDate + 'T00:00:00.000Z');
    next.setUTCDate(next.getUTCDate() + 1);
    cursorDate = isoDate(next);
  }

  // ¿Terminó caída al cierre del período? (el último tramo caído llega justo hasta 'to').
  // Sirve para mostrar el punto verde/rojo de un informe de un día YA PASADO usando cómo
  // terminó ESE día, en vez del estado de "ahora mismo" (que no tiene nada que ver con
  // un día que ya cerró, y confunde si se genera el informe de madrugada, por ejemplo).
  const endedDown = downIntervals.length > 0 && downIntervals[downIntervals.length - 1][1].getTime() === to.getTime();

  const uptimePct = operatingMs > 0 ? Math.max(0, Math.min(100, ((operatingMs - downtimeMs) / operatingMs) * 100)) : 100;
  return {
    uptimePct: Math.round(uptimePct * 10) / 10,
    disconnections: disconnections,
    downtimeMinutes: Math.round(downtimeMs / 60000),
    longestDowntimeMinutes: Math.round(longestMs / 60000),
    endedDown: endedDown,
  };
}

module.exports = { computeStoreUptime, clipIntervalToOperatingHours, dayOperatingWindow };
