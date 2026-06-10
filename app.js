const API_BASE = "https://east.albion-online-data.com";
const PRICE_ENDPOINT = `${API_BASE}/api/v2/stats/prices`;
const ITEM_URL = "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/items.json";
const CACHE_KEY = "albion-market-items-v2";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const URL_LIMIT = 3800;
const REQUEST_DELAY_MS = 420;
const TAX_MULTIPLIER = 0.97;

const CITIES = ["Bridgewatch", "Martlock", "Lymhurst", "Fort Sterling", "Thetford", "Caerleon"];
const TIERS = ["T3", "T4", "T5", "T6", "T7", "T8"];
const EXCLUDED_PREFIXES = [
  "QUEST",
  "UNIQUE",
  "SKILLBOOK",
  "TOKEN",
  "FURNITURE",
  "PLAYERISLAND",
  "GUILDISLAND",
  "JOURNAL",
  "LABOURER",
  "MOUNTUPGRADE",
  "ARTEFACT_QUEST",
];

const MARKET_KEYWORDS = [
  "ARMOR",
  "HEAD",
  "SHOES",
  "MAIN",
  "2H",
  "OFF",
  "BAG",
  "CAPE",
  "MOUNT",
  "ORE",
  "METALBAR",
  "WOOD",
  "PLANKS",
  "ROCK",
  "STONEBLOCK",
  "HIDE",
  "LEATHER",
  "FIBER",
  "CLOTH",
  "MEAL",
  "POTION",
  "FISH",
  "ESSENCE",
  "RUNE",
  "SOUL",
  "RELIC",
];

const state = {
  items: [],
  results: [],
  isScanning: false,
  cancelRequested: false,
  stats: {
    matched: 0,
    totalBatches: 0,
    currentBatch: 0,
    success: 0,
    failure: 0,
  },
};

const elements = {
  dictStatus: document.querySelector("#dictStatus"),
  scanState: document.querySelector("#scanState"),
  keywordInput: document.querySelector("#keywordInput"),
  minRoiInput: document.querySelector("#minRoiInput"),
  maxAgeInput: document.querySelector("#maxAgeInput"),
  limitInput: document.querySelector("#limitInput"),
  tierFilters: document.querySelector("#tierFilters"),
  cityFilters: document.querySelector("#cityFilters"),
  loadButton: document.querySelector("#loadButton"),
  scanButton: document.querySelector("#scanButton"),
  cancelButton: document.querySelector("#cancelButton"),
  clearButton: document.querySelector("#clearButton"),
  matchedCount: document.querySelector("#matchedCount"),
  batchCount: document.querySelector("#batchCount"),
  successCount: document.querySelector("#successCount"),
  failureCount: document.querySelector("#failureCount"),
  progressBar: document.querySelector("#progressBar"),
  progressText: document.querySelector("#progressText"),
  topCards: document.querySelector("#topCards"),
  lastUpdated: document.querySelector("#lastUpdated"),
  resultSummary: document.querySelector("#resultSummary"),
  resultsBody: document.querySelector("#resultsBody"),
  logOutput: document.querySelector("#logOutput"),
};

function init() {
  renderCheckboxes(elements.tierFilters, TIERS, "tier", true);
  renderCheckboxes(elements.cityFilters, CITIES, "city", true);
  bindEvents();
  restoreItemsFromCache();
  renderResults([]);
  updateProgress("Load the item dictionary first.");
}

function bindEvents() {
  elements.loadButton.addEventListener("click", loadItems);
  elements.scanButton.addEventListener("click", scanMarket);
  elements.cancelButton.addEventListener("click", () => {
    state.cancelRequested = true;
    setScanState("Cancelling");
    log("Cancel requested. The scan will stop after the current batch.");
  });
  elements.clearButton.addEventListener("click", clearResults);
}

function renderCheckboxes(container, values, name, checked) {
  container.innerHTML = values.map((value) => `
    <label class="check">
      <input type="checkbox" name="${name}" value="${escapeHtml(value)}" ${checked ? "checked" : ""}>
      <span>${escapeHtml(value)}</span>
    </label>
  `).join("");
}

function restoreItemsFromCache() {
  const cached = readCache();
  if (!cached) return;
  state.items = cached.items;
  elements.dictStatus.textContent = `Loaded ${formatNumber(state.items.length)} items from cache`;
  elements.scanButton.disabled = false;
  log(`Loaded item dictionary from cache: ${formatNumber(state.items.length)} items.`);
}

async function loadItems() {
  setButtons({ loading: true });
  setScanState("Loading");
  updateProgress("Downloading item dictionary...");
  log("Loading ao-data items.json.");

  try {
    const response = await fetch(ITEM_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`items.json HTTP ${response.status}`);

    const rawItems = await response.json();
    state.items = normalizeItems(rawItems);
    writeCache(state.items);

    elements.dictStatus.textContent = `Loaded ${formatNumber(state.items.length)} scannable items`;
    elements.scanButton.disabled = false;
    updateProgress(`Item dictionary ready: ${formatNumber(state.items.length)} common market items.`);
    log(`Item dictionary ready: ${formatNumber(state.items.length)} items.`);
    setScanState("Idle");
  } catch (error) {
    updateProgress("Item dictionary failed to load. Try again later.");
    log(`Item dictionary failed: ${error.message}`);
    setScanState("Error");
  } finally {
    setButtons({ loading: false });
  }
}

function normalizeItems(rawItems) {
  return rawItems
    .filter((item) => isMarketItem(item.UniqueName))
    .map((item) => {
      const id = item.UniqueName;
      return {
        id,
        name: item.LocalizedNames?.["ZH-TW"] || item.LocalizedNames?.["EN-US"] || id,
        englishName: item.LocalizedNames?.["EN-US"] || id,
        tier: id.slice(0, 2),
        category: inferCategory(id),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function isMarketItem(id) {
  if (!id || id.includes("@")) return false;
  if (!TIERS.some((tier) => id.startsWith(tier))) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => id.startsWith(prefix))) return false;
  return MARKET_KEYWORDS.some((keyword) => id.includes(keyword));
}

function inferCategory(id) {
  if (id.includes("ORE") || id.includes("METALBAR")) return "Metal";
  if (id.includes("WOOD") || id.includes("PLANKS")) return "Wood";
  if (id.includes("ROCK") || id.includes("STONEBLOCK")) return "Stone";
  if (id.includes("HIDE") || id.includes("LEATHER")) return "Leather";
  if (id.includes("FIBER") || id.includes("CLOTH")) return "Cloth";
  if (id.includes("POTION") || id.includes("MEAL") || id.includes("FISH")) return "Consumable";
  if (id.includes("MOUNT")) return "Mount";
  return "Gear";
}

async function scanMarket() {
  if (!state.items.length || state.isScanning) return;

  const selectedCities = getSelectedValues("city");
  if (selectedCities.length < 2) {
    updateProgress("Select at least two cities.");
    return;
  }

  const filteredItems = getFilteredItems();
  if (!filteredItems.length) {
    renderResults([]);
    updateProgress("No items match the current filters.");
    return;
  }

  const batches = createPriceBatches(filteredItems.map((item) => item.id), selectedCities);
  resetScanStats(filteredItems.length, batches.length);
  state.results = [];
  state.isScanning = true;
  state.cancelRequested = false;

  setScanState("Scanning");
  setButtons({ scanning: true });
  renderResults([]);
  log(`Scanning ${formatNumber(filteredItems.length)} items in ${batches.length} batches.`);

  const itemMap = new Map(filteredItems.map((item) => [item.id, item]));
  const maxAgeDays = Number(elements.maxAgeInput.value) || 7;
  const minRoi = (Number(elements.minRoiInput.value) || 0) / 100;

  for (const batch of batches) {
    if (state.cancelRequested) break;

    state.stats.currentBatch += 1;
    updateProgress(`Fetching batch ${state.stats.currentBatch} / ${state.stats.totalBatches}...`);

    try {
      const data = await fetchPrices(batch, selectedCities);
      state.stats.success += 1;
      state.results.push(...findOpportunities(data, itemMap, selectedCities, maxAgeDays, minRoi));
      renderResults(state.results);
    } catch (error) {
      state.stats.failure += 1;
      log(`Batch ${state.stats.currentBatch} failed: ${error.message}`);
    }

    updateProgress();
    if (state.stats.currentBatch < batches.length) await sleep(REQUEST_DELAY_MS);
  }

  state.isScanning = false;
  setButtons({ scanning: false });

  if (state.cancelRequested) {
    setScanState("Cancelled");
    updateProgress("Scan cancelled. Current results were kept.");
    log("Scan cancelled.");
  } else {
    setScanState("Done");
    updateProgress(`Scan complete. Found ${formatNumber(state.results.length)} opportunities.`);
    log(`Scan complete: ${formatNumber(state.results.length)} opportunities.`);
  }
}

function getFilteredItems() {
  const keyword = elements.keywordInput.value.trim().toLowerCase();
  const selectedTiers = getSelectedValues("tier");

  return state.items.filter((item) => {
    const matchesTier = selectedTiers.includes(item.tier);
    const matchesKeyword = !keyword ||
      item.id.toLowerCase().includes(keyword) ||
      item.name.toLowerCase().includes(keyword) ||
      item.englishName.toLowerCase().includes(keyword);
    return matchesTier && matchesKeyword;
  });
}

function getSelectedValues(name) {
  return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map((input) => input.value);
}

function createPriceBatches(itemIds, cities) {
  const batches = [];
  let current = [];

  for (const itemId of itemIds) {
    const candidate = [...current, itemId];
    if (buildPriceUrl(candidate, cities).length > URL_LIMIT && current.length) {
      batches.push(current);
      current = [itemId];
    } else {
      current = candidate;
    }
  }

  if (current.length) batches.push(current);
  return batches;
}

function buildPriceUrl(itemIds, cities) {
  const ids = itemIds.map(encodeURIComponent).join(",");
  const locations = cities.map(encodeURIComponent).join(",");
  return `${PRICE_ENDPOINT}/${ids}.json?locations=${locations}`;
}

async function fetchPrices(itemIds, cities) {
  const url = buildPriceUrl(itemIds, cities);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`price API HTTP ${response.status}`);
  return response.json();
}

function findOpportunities(rows, itemMap, selectedCities, maxAgeDays, minRoi) {
  const byItem = new Map();

  for (const row of rows) {
    if (!row.item_id || !selectedCities.includes(row.city)) continue;
    if (!byItem.has(row.item_id)) byItem.set(row.item_id, new Map());

    const cityMap = byItem.get(row.item_id);
    const previous = cityMap.get(row.city);
    if (!previous || getMostRecentTime(row) > getMostRecentTime(previous)) {
      cityMap.set(row.city, row);
    }
  }

  const opportunities = [];
  const now = Date.now();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;

  for (const [itemId, cityMap] of byItem.entries()) {
    const item = itemMap.get(itemId);
    if (!item) continue;

    for (const fromCity of cityMap.keys()) {
      for (const toCity of cityMap.keys()) {
        if (fromCity === toCity) continue;

        const buyRow = cityMap.get(fromCity);
        const sellRow = cityMap.get(toCity);
        const buy = Number(buyRow.sell_price_min);
        const sell = Number(sellRow.buy_price_max);
        const buyTime = parseDate(buyRow.sell_price_min_date);
        const sellTime = parseDate(sellRow.buy_price_max_date);

        if (!buy || !sell || buy <= 0 || sell <= 0) continue;
        if (!buyTime || !sellTime) continue;
        if (now - buyTime.getTime() > maxAgeMs || now - sellTime.getTime() > maxAgeMs) continue;

        const profit = Math.floor(sell * TAX_MULTIPLIER - buy);
        const roi = profit / buy;
        if (profit <= 0 || roi < minRoi) continue;

        opportunities.push({
          itemId,
          name: item.name,
          englishName: item.englishName,
          category: item.category,
          fromCity,
          toCity,
          buy,
          sell,
          profit,
          roi,
          buyTime,
          sellTime,
        });
      }
    }
  }

  return opportunities;
}

function renderResults(results) {
  const sorted = [...results].sort((a, b) => b.roi - a.roi || b.profit - a.profit);
  const limit = Number(elements.limitInput.value) || 100;
  const visible = sorted.slice(0, limit);

  elements.resultSummary.textContent = results.length
    ? `${formatNumber(results.length)} total, showing top ${formatNumber(visible.length)}`
    : "No matching results";

  elements.lastUpdated.textContent = results.length
    ? `Updated ${new Date().toLocaleTimeString("en-US")}`
    : "No results yet";

  elements.topCards.innerHTML = visible.slice(0, 3).map(renderTopCard).join("") ||
    `<div class="empty">No resale opportunities yet.</div>`;

  elements.resultsBody.innerHTML = visible.map(renderResultRow).join("") ||
    `<tr><td colspan="7" class="empty">No matching results.</td></tr>`;
}

function renderTopCard(row) {
  return `
    <article class="top-card">
      <strong>${escapeHtml(row.name)}</strong>
      <div class="roi">${formatPercent(row.roi)}</div>
      <div class="route">${escapeHtml(row.fromCity)} to ${escapeHtml(row.toCity)}</div>
      <div class="meta">Profit ${formatNumber(row.profit)} / ${escapeHtml(row.itemId)}</div>
    </article>
  `;
}

function renderResultRow(row) {
  return `
    <tr>
      <td>
        <strong>${escapeHtml(row.name)}</strong>
        <div class="item-id">${escapeHtml(row.englishName)} / ${escapeHtml(row.itemId)} / ${escapeHtml(row.category)}</div>
      </td>
      <td>${escapeHtml(row.fromCity)} to ${escapeHtml(row.toCity)}</td>
      <td>${formatNumber(row.buy)}</td>
      <td>${formatNumber(row.sell)}</td>
      <td class="profit">${formatNumber(row.profit)}</td>
      <td class="roi-cell">${formatPercent(row.roi)}</td>
      <td>
        <div class="time">Buy ${formatDate(row.buyTime)}</div>
        <div class="time">Sell ${formatDate(row.sellTime)}</div>
      </td>
    </tr>
  `;
}

function resetScanStats(matched, totalBatches) {
  state.stats = {
    matched,
    totalBatches,
    currentBatch: 0,
    success: 0,
    failure: 0,
  };
  updateProgress();
}

function updateProgress(message) {
  const { matched, totalBatches, currentBatch, success, failure } = state.stats;
  elements.matchedCount.textContent = formatNumber(matched);
  elements.batchCount.textContent = `${formatNumber(currentBatch)} / ${formatNumber(totalBatches)}`;
  elements.successCount.textContent = formatNumber(success);
  elements.failureCount.textContent = formatNumber(failure);

  const percent = totalBatches ? Math.round((currentBatch / totalBatches) * 100) : 0;
  elements.progressBar.style.width = `${percent}%`;
  if (message) elements.progressText.textContent = message;
}

function clearResults() {
  if (state.isScanning) return;
  state.results = [];
  state.stats = { matched: 0, totalBatches: 0, currentBatch: 0, success: 0, failure: 0 };
  renderResults([]);
  updateProgress("Results cleared.");
  elements.logOutput.textContent = "";
  setScanState("Idle");
}

function setButtons({ loading = false, scanning = false }) {
  elements.loadButton.disabled = loading || scanning;
  elements.scanButton.disabled = loading || scanning || !state.items.length;
  elements.cancelButton.disabled = !scanning;
  elements.clearButton.disabled = loading || scanning;
}

function setScanState(label) {
  elements.scanState.textContent = label;
}

function readCache() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (!cached || Date.now() - cached.savedAt > CACHE_TTL_MS) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeCache(items) {
  localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), items }));
}

function getMostRecentTime(row) {
  const buyTime = parseDate(row.buy_price_max_date)?.getTime() || 0;
  const sellTime = parseDate(row.sell_price_min_date)?.getTime() || 0;
  return Math.max(buyTime, sellTime);
}

function parseDate(value) {
  if (!value || value.startsWith("0001-")) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  return date.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function log(message) {
  const time = new Date().toLocaleTimeString("en-US");
  elements.logOutput.textContent += `[${time}] ${message}\n`;
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

init();
