
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const hostname = process.env.MONGO_HOST || "127.0.0.1";
(async () => {
  // Espera un poco a que arranque el servidor (por seguridad)
  await sleep(4000);

  try {
    // Conexión local al admin (durante init NO hay auth todavía)
    // La imagen oficial ejecuta estos scripts antes de habilitar autenticación.
    const status = rs.status(); // si no está iniciado, lanzará error
    // Si llega aquí, ya hay RS configurado y no hacemos nada
    print("Replica set already initiated:", tojson(status));
  } catch (e) {
    print("No replica set config yet. Initiating...");
    try {
      rs.initiate({
        _id: "rs0",
        members: [{ _id: 0, host: `${hostname}:27017` }]
      });
      // Esperar a PRIMARY
      let tries = 0;
      while (tries < 30) {
        const s = rs.status();
        if (s.members && s.members[0] && s.members[0].stateStr === "PRIMARY") {
          print("Replica set PRIMARY is up.");
          break;
        }
        await sleep(1000);
        tries++;
      }
    } catch (err) {
      print("Error initiating replica set:", err);
    }
  }
})();
