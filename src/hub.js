// In-process SSE hub. Realtime is a *hint* ("something changed"); clients re-fetch
// authoritative state, so a missed message is harmless.
function createHub() {
  const conns = new Set(); // {res, userId, teams:Set}
  const send = (c, payload) => c.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  const hub = {
    add(res, userId, teamIds) {
      const c = { res, userId, teams: new Set(teamIds) };
      conns.add(c);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      res.on('close', () => { clearInterval(ping); conns.delete(c); });
      send(c, { type: 'hello' });
    },
    publishTeam(teamId, payload) { for (const c of conns) if (c.teams.has(teamId)) send(c, payload); },
    publishUsers(userIds, payload) { for (const c of conns) if (userIds.includes(c.userId)) send(c, payload); },
    size: () => conns.size,
  };
  return hub;
}
module.exports = { createHub };
