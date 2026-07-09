// ============================================================
// Mika 旅遊路線規劃 — 全域設定
// 串接真實服務時，只需要改這個檔案（詳見「手把手設定教學.md」）
// ============================================================
const CONFIG = {
  // 'mock'：模擬模式（免 API Key，用內建台北示範資料；雲端以本機模擬）
  // 'real'：正式模式（需填妥下方 googleApiKey 與 gasUrl）
  mode: 'real',

  // Google Maps / Places / Directions 共用的 API Key
  googleApiKey: 'AIzaSyDJDgQIOMOpH71BlbVFwCUPqotkSA3gn6E',

  // Google Apps Script Web App 部署後的網址（https://script.google.com/macros/s/…/exec）
  gasUrl: 'https://script.google.com/macros/s/AKfycbyxPzP67gKqfrlzkRD4jllwrZH73NB4aWt5_z1ffNsbqNXBj8voWqNAxCI4-PEs4t5Qpg/exec',

  // 版本號（改版只更這裡，標題列自動帶出）
  version: 'v2-test.2',

  // 天氣（Open-Meteo 免費免 Key，模擬/正式模式都直接用真資料）
  weatherApi: 'https://api.open-meteo.com/v1/forecast',
  forecastMaxDays: 16,
  routeMatrixMaxStops: 10,

  // 預設值
  defaults: {
    stayMin: 60,          // 預設停留 60 分鐘
    dayStart: '09:00',
    dayEnd: '21:00',
    rainThreshold: 60,    // 降雨機率 ≥ 60% 觸發備案提示
    minRating: 4.0        // 推薦清單最低評分
  }
};
