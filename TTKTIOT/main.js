let barChart, areaChart;

// ================== FLAGS ==================
let currentPage = "dashboard";
let isAutoMode = false;   // auto theo threshold
let isTimerMode = false;  // timer theo giờ
let firebaseStarted = false;
let syncStarted = false;

// Cache sensor để dashboard không bị "--" khi chuyển trang
let latestSensorData = null;

// ================== CHART CACHE (KHÔNG RESET) ==================
let chartCache = {
  labels: [],
  dust: [],
  co: [],
  temp: [],
  humi: []
};

// ================== THRESHOLD ==================
let autoThreshold = {
  temp: 50,
  humi: 50,
  dust: 70,
  co: 90
};

// ================== STATE (KHÔNG RESET) ==================
let deviceState = {
  lamp: 0,
  fan: 0,
  fanLevel: 1,
  vacuum: 0,
  air: 0
};

// ================== TIMER SETTINGS ==================
let timerSettings = {
  lamp: { on: null, off: null },
  fan: { on: null, off: null },
  vacuum: { on: null, off: null },
  air: { on: null, off: null }
};

// ================== intervals ==================
let timerIntervalId = null;

// ================== audio ==================
const audioVacuum = new Audio("mp3/val.mp3");
const audioBell = new Audio("mp3/bell.mp3");

// ================== DB WRITE HELPERS ==================
function writeDevicesToDB() {
  return database.ref("devices").update({
    lamp: deviceState.lamp,
    vacuum: deviceState.vacuum,
    air: deviceState.air,
    fanLevel: deviceState.fanLevel,
    fan: deviceState.fanLevel > 1 ? 1 : 0
  }).catch((err) => {
    console.error(" writeDevicesToDB failed:", err);
  });
}

function writeThresholdToDB() {
  return database.ref("threshold").set({
    temp: autoThreshold.temp,
    humi: autoThreshold.humi,
    dust: autoThreshold.dust,
    co: autoThreshold.co
  }).catch((err) => {
    console.error("writeThresholdToDB failed:", err);
  });
}

function writeModeToDB(mode) {
  return database.ref("control/mode").set(mode).catch((err) => {
    console.error("❌ writeModeToDB failed:", err);
  });
}

function writeTimerToDB() {
  return database.ref("timer").set(timerSettings).catch((err) => {
    console.error("❌ writeTimerToDB failed:", err);
  });
}

// ================== DASHBOARD RENDER VALUES (FIX "--") ==================
function renderDashboardValues(data) {
  if (!data) return;

  const tEl = document.getElementById("tempt");
  const hEl = document.getElementById("humi");
  const dEl = document.getElementById("rain");
  const cEl = document.getElementById("light");

  if (tEl) tEl.innerText = data.temperature + " °C";
  if (hEl) hEl.innerText = data.humidity + " %";
  if (dEl) dEl.innerText = data.dust + " µg/m³";
  if (cEl) cEl.innerText = data.co + " ppm";
}

// ================== MODE UI ==================
function getModeLabel() {
  if (isTimerMode) return "TIMER MODE";
  if (isAutoMode) return "AUTO MODE";
  return "MANUAL MODE";
}

function updateModeUI() {
  if (currentPage !== "control") return;

  const stt = document.getElementById("stt_img");
  const mode = document.getElementById("mode");
  if (!stt || !mode) return;

  stt.src = (isAutoMode || isTimerMode) ? "./img/auto.png" : "./img/manual.png";
  mode.innerText = getModeLabel();
}

// ================== RENDER CONTROL UI ==================
function renderControlUI() {
  if (currentPage !== "control") return;

  const lampImg = document.getElementById("lam");
  const lampBtnImg = document.getElementById("lamp_but");

  const fanImg = document.getElementById("fan");
  const fanBtnImg = document.getElementById("fan_but");

  const cleanImg = document.getElementById("clean");
  const cleanBtnImg = document.getElementById("clean_but");

  const airImg = document.getElementById("air");
  const airBtnImg = document.getElementById("air_but");

  // LAMP
  if (lampImg && lampBtnImg) {
    if (deviceState.lamp === 1) {
      lampImg.src = "./img/lam_5.png";
      lampBtnImg.src = "./img/btn_off.png";
    } else {
      lampImg.src = "./img/lam_1.png";
      lampBtnImg.src = "./img/btn_on.png";
    }
  }

  // FAN
  if (fanImg && fanBtnImg) {
    fanImg.classList.remove("spinStop", "spin1", "spin2", "spin3", "spin4");

    const lvl = deviceState.fanLevel;
    if (lvl === 1) { fanBtnImg.src = "./img/fanb1.png"; fanImg.classList.add("spinStop"); }
    else if (lvl === 2) { fanBtnImg.src = "./img/fanb2.png"; fanImg.classList.add("spin1"); }
    else if (lvl === 3) { fanBtnImg.src = "./img/fanb3.png"; fanImg.classList.add("spin2"); }
    else if (lvl === 4) { fanBtnImg.src = "./img/fanb4.png"; fanImg.classList.add("spin3"); }
    else if (lvl === 5) { fanBtnImg.src = "./img/fanb5.png"; fanImg.classList.add("spin4"); }
  }

  // VACUUM
  if (cleanImg && cleanBtnImg) {
    if (deviceState.vacuum === 1) {
      cleanImg.src = "./img/clean_on.png";
      cleanBtnImg.src = "./img/btn_off.png";
    } else {
      cleanImg.src = "./img/clean_off.png";
      cleanBtnImg.src = "./img/btn_on.png";
    }
  }

  // AIR
  if (airImg && airBtnImg) {
    if (deviceState.air === 1) {
      airImg.src = "./img/air_on.png";
      airBtnImg.src = "./img/air_bon.png";
    } else {
      airImg.src = "./img/air_off.png";
      airBtnImg.src = "./img/air_boff.png";
    }
  }

  updateModeUI();
}

// ================== APPLY DEVICE STATE (UPDATE + WRITE DB) ==================
function applyDeviceState(device, state) {
  const s = state ? 1 : 0;

  if (device === "lamp") deviceState.lamp = s;

  if (device === "fan") {
    // giữ logic bạn: bật => level 5, tắt => level 1
    deviceState.fanLevel = s ? 5 : 1;
  }

  if (device === "vacuum") {
    deviceState.vacuum = s;
    if (s === 1) {
      audioVacuum.currentTime = 0;
      audioVacuum.play().catch(() => {});
    } else {
      audioVacuum.pause();
    }
  }

  if (device === "air") deviceState.air = s;

  renderControlUI();

  // ✅ GHI DB NGAY
  writeDevicesToDB();
}

// ================== AUTO THRESHOLD LOGIC ==================
function checkThresholds(data) {
  if (!isAutoMode) return;

  const anyOver =
    data.temperature > autoThreshold.temp ||
    data.humidity > autoThreshold.humi ||
    data.dust > autoThreshold.dust ||
    data.co > autoThreshold.co;

  applyDeviceState("lamp", anyOver ? 1 : 0);
  applyDeviceState("vacuum", data.dust > autoThreshold.dust ? 1 : 0);
  applyDeviceState("fan", data.co > autoThreshold.co ? 1 : 0);

  const airOver =
    data.temperature > autoThreshold.temp ||
    data.humidity > autoThreshold.humi;

  applyDeviceState("air", airOver ? 1 : 0);
}

// ================== FIREBASE SENSOR LISTENER (1 LẦN) ==================
function startFirebaseListenerOnce() {
  if (firebaseStarted) return;
  firebaseStarted = true;

  const sensorRef = database.ref("sensor");

  sensorRef.on("value", snapshot => {
    const data = snapshot.val();
    if (!data) return;

    const safeData = {
      temperature: Number(data.temperature),
      humidity: Number(data.humidity),
      dust: Number(data.dust),
      co: Number(data.co)
    };

    latestSensorData = safeData;

    // update numbers nếu dashboard đang tồn tại
    renderDashboardValues(latestSensorData);

    // ✅ update chart + cache
    updateCharts(safeData);

    // check threshold ngay khi dữ liệu về
    checkThresholds(safeData);
  });
}

// ================== SYNC FROM DB (APP/WEB 2 CHIỀU) ==================
function startSyncFromDBOnce() {
  if (syncStarted) return;
  syncStarted = true;

  // devices
  database.ref("devices").on("value", (snap) => {
    const d = snap.val();
    if (!d) return;

    deviceState.lamp = Number(d.lamp || 0);
    deviceState.vacuum = Number(d.vacuum || 0);
    deviceState.air = Number(d.air || 0);
    deviceState.fanLevel = Number(d.fanLevel || 1);

    renderControlUI();
  });

  // threshold
  database.ref("threshold").on("value", (snap) => {
    const t = snap.val();
    if (!t) return;

    autoThreshold.temp = Number(t.temp ?? autoThreshold.temp);
    autoThreshold.humi = Number(t.humi ?? autoThreshold.humi);
    autoThreshold.dust = Number(t.dust ?? autoThreshold.dust);
    autoThreshold.co = Number(t.co ?? autoThreshold.co);

    // nếu đang ở control thì cập nhật số dưới slider
    if (currentPage === "control") {
      const a = document.querySelector(".scrollable-range");
      const b = document.querySelector(".scrollable-range1");
      const c = document.querySelector(".scrollable-range2");
      const d2 = document.querySelector(".scrollable-range3");

      if (a) { a.value = autoThreshold.temp; const el = document.getElementById("scroll-value"); if (el) el.innerText = autoThreshold.temp; }
      if (b) { b.value = autoThreshold.humi; const el = document.getElementById("scroll-value1"); if (el) el.innerText = autoThreshold.humi; }
      if (c) { c.value = autoThreshold.dust; const el = document.getElementById("scroll-value2"); if (el) el.innerText = autoThreshold.dust; }
      if (d2){ d2.value = autoThreshold.co;   const el = document.getElementById("scroll-value3"); if (el) el.innerText = autoThreshold.co; }
    }

    if (latestSensorData) checkThresholds(latestSensorData);
  });

  // mode
  database.ref("control/mode").on("value", (snap) => {
    const m = snap.val();
    if (!m) return;

    isAutoMode = (m === "auto");
    isTimerMode = (m === "timer");
    updateModeUI();

    if (isAutoMode && latestSensorData) checkThresholds(latestSensorData);
  });

  // timer
  database.ref("timer").on("value", (snap) => {
    const t = snap.val();
    if (!t) return;
    timerSettings = t;
  });
}

// ================== CLOCK ==================
function startClock() {
  function updateTime() {
    const t = new Date();
    const h = String(t.getHours()).padStart(2, '0');
    const m = String(t.getMinutes()).padStart(2, '0');
    const s = String(t.getSeconds()).padStart(2, '0');
    const timeEl = document.getElementById("time");
    if (timeEl) timeEl.innerText = `${h}:${m}:${s}`;
  }
  updateTime();
  setInterval(updateTime, 1000);
}

// ================== CHARTS ==================
function loadCharts() {
  const barCtx = document.getElementById('barChart');
  const areaCtx = document.getElementById('areaChart');

  barChart = new Chart(barCtx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        { label: "Dust", data: [], yAxisID: 'leftAxis', backgroundColor: "#006699" },
        { label: "CO", data: [], yAxisID: 'rightAxis', backgroundColor: "#993333" }
      ]
    },
    options: {
      responsive: true,
      plugins: { legend: { position: "bottom" } },
      scales: {
        leftAxis: { position: 'left', min: 0 },
        rightAxis: { position: 'right', min: 0, grid: { drawOnChartArea: false } }
      }
    }
  });

  areaChart = new Chart(areaCtx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          label: "Temperature",
          data: [],
          fill: true,
          borderColor: "#A23A00",
          backgroundColor: "rgba(200,120,70,0.3)"
        },
        {
          label: "Humidity",
          data: [],
          fill: true,
          borderColor: "#000066",
          backgroundColor: "rgba(90,120,255,0.3)"
        }
      ]
    },
    options: {
      responsive: true,
      tension: 0.4,
      plugins: { legend: { position: "bottom" } }
    }
  });
}

function restoreChartsFromCache() {
  if (!barChart || !areaChart) return;
  if (chartCache.labels.length === 0) return;

  barChart.data.labels = [...chartCache.labels];
  barChart.data.datasets[0].data = [...chartCache.dust];
  barChart.data.datasets[1].data = [...chartCache.co];

  areaChart.data.labels = [...chartCache.labels];
  areaChart.data.datasets[0].data = [...chartCache.temp];
  areaChart.data.datasets[1].data = [...chartCache.humi];

  barChart.update();
  areaChart.update();
}

function updateCharts(data) {
  const timeLabel = new Date().toLocaleTimeString();

  // ====== LƯU CACHE ======
  chartCache.labels.push(timeLabel);
  chartCache.dust.push(data.dust);
  chartCache.co.push(data.co);
  chartCache.temp.push(data.temperature);
  chartCache.humi.push(data.humidity);

  // Giữ tối đa 10 điểm
  if (chartCache.labels.length > 10) {
    chartCache.labels.shift();
    chartCache.dust.shift();
    chartCache.co.shift();
    chartCache.temp.shift();
    chartCache.humi.shift();
  }

  // ====== UPDATE CHART NẾU ĐANG CÓ CHART ======
  if (!barChart || !areaChart) return;

  barChart.data.labels = [...chartCache.labels];
  barChart.data.datasets[0].data = [...chartCache.dust];
  barChart.data.datasets[1].data = [...chartCache.co];

  areaChart.data.labels = [...chartCache.labels];
  areaChart.data.datasets[0].data = [...chartCache.temp];
  areaChart.data.datasets[1].data = [...chartCache.humi];

  barChart.update();
  areaChart.update();
}

// ================== CONTROL PAGE INIT ==================
function initControlPage() {
  // Lamp manual
  document.getElementById("lamp_button").onclick = function () {
    deviceState.lamp = 1 - deviceState.lamp;
    applyDeviceState("lamp", deviceState.lamp);
    writeModeToDB("manual");
  };

  // Fan manual level
  document.getElementById("fan_button").onclick = function () {
    deviceState.fanLevel++;
    if (deviceState.fanLevel > 5) deviceState.fanLevel = 1;
    renderControlUI();
    writeDevicesToDB();
    writeModeToDB("manual");
  };

  // Vacuum manual
  document.getElementById("clean_button").onclick = function () {
    deviceState.vacuum = 1 - deviceState.vacuum;
    applyDeviceState("vacuum", deviceState.vacuum);
    writeModeToDB("manual");
  };

  // Air manual
  document.getElementById("air_button").onclick = function () {
    deviceState.air = 1 - deviceState.air;
    applyDeviceState("air", deviceState.air);
    writeModeToDB("manual");
  };

  // DEFAULT
  document.getElementById("def_but").onclick = function () {
    isAutoMode = false;
    isTimerMode = false;

    deviceState.lamp = 0;
    deviceState.fanLevel = 1;
    deviceState.vacuum = 0;
    deviceState.air = 0;

    audioVacuum.pause();
    renderControlUI();

    writeDevicesToDB();
    writeModeToDB("manual");
  };

  // TURN ALL
  document.getElementById("all_on").onclick = function () {
    deviceState.lamp = 1;
    deviceState.fanLevel = 5;
    deviceState.air = 1;
    applyDeviceState("vacuum", 1);
    renderControlUI();

    writeDevicesToDB();
    writeModeToDB("manual");
  };

  // SLIDERS
  const sliders = [
    { input: document.querySelector(".scrollable-range"), display: "scroll-value", key: "temp" },
    { input: document.querySelector(".scrollable-range1"), display: "scroll-value1", key: "humi" },
    { input: document.querySelector(".scrollable-range2"), display: "scroll-value2", key: "dust" },
    { input: document.querySelector(".scrollable-range3"), display: "scroll-value3", key: "co" }
  ];

  sliders.forEach((s) => {
    s.input.addEventListener("input", () => {
      const val = Number(s.input.value);
      const el = document.getElementById(s.display);
      if (el) el.innerText = val;

      autoThreshold[s.key] = val;

      isAutoMode = true;
      isTimerMode = false;
      updateModeUI();

      writeThresholdToDB();
      writeModeToDB("auto");

      if (latestSensorData) checkThresholds(latestSensorData);
    });
  });

  // TIMER MODAL
  const modal = document.getElementById("myModal");
  document.getElementById("all_off").onclick = function () {
    modal.style.display = "block";
    isTimerMode = true;
    isAutoMode = false;
    updateModeUI();
    writeModeToDB("timer");
  };

  document.getElementById("confirmTimer").onclick = function () {
    timerSettings.lamp.on = document.getElementById("lampTurnOnTime").value;
    timerSettings.lamp.off = document.getElementById("lampTurnOffTime").value;

    timerSettings.fan.on = document.getElementById("fanTurnOnTime").value;
    timerSettings.fan.off = document.getElementById("fanTurnOffTime").value;

    timerSettings.vacuum.on = document.getElementById("vacuumTurnOnTime").value;
    timerSettings.vacuum.off = document.getElementById("vacuumTurnOffTime").value;

    timerSettings.air.on = document.getElementById("airTurnOnTime").value;
    timerSettings.air.off = document.getElementById("airTurnOffTime").value;

    modal.style.display = "none";
    audioBell.play().catch(() => {});
    updateModeUI();

    writeTimerToDB();
  };
}

// ✅ FIX TIMER: chuẩn hóa format HH:MM, tránh null/""
function normalizeHHMM(x) {
  if (!x) return "";
  return String(x).slice(0, 5);
}

// ================== TIMER SYSTEM (1 LẦN) ==================
if (timerIntervalId) clearInterval(timerIntervalId);
timerIntervalId = setInterval(() => {
  if (!isTimerMode) return;

  const cur = new Date().toTimeString().slice(0, 5);

  for (let dev in timerSettings) {
    const onT = normalizeHHMM(timerSettings[dev]?.on);
    const offT = normalizeHHMM(timerSettings[dev]?.off);

    if (onT && onT === cur) applyDeviceState(dev, 1);
    if (offT && offT === cur) applyDeviceState(dev, 0);
  }
}, 1000);

// ================== SHOW PAGE ==================
function showPage(page, element) {
  currentPage = page;
  const content = document.getElementById("content-area");

  if (page === "dashboard") {
    content.innerHTML = `
      <div class="top-row">
        <div class="top-title">WELCOME TO OUR IOT DASHBOARD</div>
        <button id="ggSheets" class="top-btn">GO TO SHEET</button>
        <div id="time" class="top-time"></div>
      </div>

      <div class="main-cards">
        <div class="card"><div class="card-inner"><p>TEMPERATURE</p></div><span id="tempt">--</span></div>
        <div class="card"><div class="card-inner"><p>HUMIDITY</p></div><span id="humi">--</span></div>
        <div class="card"><div class="card-inner"><p>DUST</p></div><span id="rain">--</span></div>
        <div class="card"><div class="card-inner"><p>CO</p></div><span id="light">--</span></div>
      </div>

      <div class="charts">
        <div class="charts-card">
          <p class="chart-title">Dust & CO</p>
          <canvas id="barChart"></canvas>
        </div>

        <div class="charts-card">
          <p class="chart-title">Temperature & Humidity</p>
          <canvas id="areaChart"></canvas>
        </div>
      </div>
    `;

    renderDashboardValues(latestSensorData);

    startClock();
    loadCharts();
    restoreChartsFromCache(); // ✅ chart không reset

    const ggBtn = document.getElementById("ggSheets");
    if (ggBtn) {
      ggBtn.onclick = () => {
        window.open("https://docs.google.com/spreadsheets/d/1n_ilYDpPTjtslFZpjL4GqPP1CQbQfodpSU_jIvRcxr0/edit?gid=0#gid=0", "_blank");
      };
    }
  }

  else if (page === "control") {
    content.innerHTML = `
      <div class="image-but">
        <div class="room1">

          <div class="box-section">
            <p class="box-title">DEVICE</p>
            <div class="image">
              <img id="lam" src="./img/lam_1.png" style="width:15%">
              <img id="fan" src="./img/cq.png" style="width:15%">
              <img id="clean" src="./img/clean_off.png" style="width:15%">
              <img id="air" src="./img/air_off.png" style="width:15%">
            </div>
            <div class="name_device">
              <pre><strong>     Device 1          Device 2           Device 3        Device 4     </strong></pre>
            </div>
          </div>

          <div class="box-section">
            <p class="box-title">CONTROL</p>
            <div class="button_all">
              <button id="lamp_button"><img id="lamp_but" src="./img/lam_1.png" style="width:40%"></button>
              <button id="fan_button"><img id="fan_but" src="./img/fanb1.png" style="width:40%"></button>
              <button id="clean_button"><img id="clean_but" src="./img/btn_on.png" style="width:40%"></button>
              <button id="air_button"><img id="air_but" src="./img/air_boff.png" style="width:40%"></button>
            </div>
          </div>

          <div class="box-section">
            <p class="box-title">FEATURES</p>
            <div class="features-container">
              <button id="def_but">DEFAULT</button>
              <button id="all_on">TURN ALL</button>
              <button id="all_off">TIMER</button>
            </div>
          </div>

        </div>

        <div class="room2">
          <div class="title_room2">THRESHOLD VALUES</div>

          <div class="tempt_roll">
            <img src="./img/tempt.png" style="width:17%;height:17%">
            <input type="range" min="0" max="100" value="${autoThreshold.temp}" class="scrollable-range">
            <p id="scroll-value">${autoThreshold.temp}</p>
          </div>

          <div class="humi_roll">
            <img src="./img/humi.png" style="width:17%;height:17%">
            <input type="range" min="0" max="100" value="${autoThreshold.humi}" class="scrollable-range1">
            <p id="scroll-value1">${autoThreshold.humi}</p>
          </div>

          <div class="bu_roll">
            <img src="./img/dust.png" style="width:17%;height:17%">
            <input type="range" min="0" max="1000" value="${autoThreshold.dust}" class="scrollable-range2">
            <p id="scroll-value2">${autoThreshold.dust}</p>
          </div>

          <div class="soil_roll">
            <img src="./img/CO.png" style="width:17%;height:17%">
            <input type="range" min="0" max="1000" value="${autoThreshold.co}" class="scrollable-range3">
            <p id="scroll-value3">${autoThreshold.co}</p>
          </div>

          <div class="status">
            <img id="stt_img" src="${(isAutoMode || isTimerMode) ? "./img/auto.png" : "./img/manual.png"}" style="width:20%">
            <span id="mode">${getModeLabel()}</span>
          </div>
        </div>
      </div>

      <div id="myModal" class="modal">
        <div class="modal-content">
          <div class="frames-container">

            <div class="frame">
              <h2>LAMP</h2>
              <div class="option"><label>Time On:</label><input type="time" id="lampTurnOnTime" value="${timerSettings.lamp.on ?? ""}"></div>
              <div class="option"><label>Time Off:</label><input type="time" id="lampTurnOffTime" value="${timerSettings.lamp.off ?? ""}"></div>
            </div>

            <div class="frame">
              <h2>FAN</h2>
              <div class="option"><label>Time On:</label><input type="time" id="fanTurnOnTime" value="${timerSettings.fan.on ?? ""}"></div>
              <div class="option"><label>Time Off:</label><input type="time" id="fanTurnOffTime" value="${timerSettings.fan.off ?? ""}"></div>
            </div>

            <div class="frame">
              <h2>VACUUM</h2>
              <div class="option"><label>Time On:</label><input type="time" id="vacuumTurnOnTime" value="${timerSettings.vacuum.on ?? ""}"></div>
              <div class="option"><label>Time Off:</label><input type="time" id="vacuumTurnOffTime" value="${timerSettings.vacuum.off ?? ""}"></div>
            </div>

            <div class="frame">
              <h2>AIR COND</h2>
              <div class="option"><label>Time On:</label><input type="time" id="airTurnOnTime" value="${timerSettings.air.on ?? ""}"></div>
              <div class="option"><label>Time Off:</label><input type="time" id="airTurnOffTime" value="${timerSettings.air.off ?? ""}"></div>
            </div>

          </div>

          <button id="confirmTimer">Finish</button>
        </div>
      </div>
    `;

    initControlPage();
    renderControlUI();
  }

  else if (page === "about") {
    content.innerHTML = `
      <h2>About Project</h2>
      <p>This project was designed by Nhom13.</p>
    `;
  }

  document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
  element.classList.add('active');
}

// ================== START ==================
startFirebaseListenerOnce();
startSyncFromDBOnce();
showPage('dashboard', document.querySelector('.nav-link.active'));
