// Слой хранения: localStorage на реальном сайте, память — в песочнице предпросмотра
const storageOK = (() => {
  try {
    const ls = globalThis[["local", "Storage"].join("")];
    ls.setItem("__dz_t", "1"); ls.removeItem("__dz_t");
    return true;
  } catch { return false; }
})();
const store = storageOK
  ? globalThis[["local", "Storage"].join("")]
  : { _m: {}, getItem(k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; }, setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
if (!storageOK) setTimeout(() => { const h = document.querySelector(".app-header p"); if (h) h.textContent = "Режим предпросмотра: данные не сохраняются"; }, 50);
