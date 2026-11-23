// Netlify Blobs store with "strong" reads when this site's environment supports them, otherwise normal reads
// (which can lag by up to about a minute, so a Stop may take that long to be noticed).
const { getStore, connectLambda } = require("@netlify/blobs");
let strongOk = true;
function open(ev) {
  try { if (ev) connectLambda(ev); } catch (e) {}
  const st = getStore({ name: "smsjobs" });
  return {
    async get(k, o) {
      if (strongOk) { try { return await st.get(k, { ...o, consistency: "strong" }); } catch (e) { if (!/uncachedEdgeURL|strong/i.test(String(e.message))) throw e; strongOk = false; } }
      return st.get(k, o);
    },
    set: (k, v) => st.set(k, v), setJSON: (k, v) => st.setJSON(k, v), delete: k => st.delete(k),
  };
}
module.exports = { open };
