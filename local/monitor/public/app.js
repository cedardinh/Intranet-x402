const FLOW_STEPS = [
  "chat.user_message.received",
  "assistant.intent.resolved",
  "assistant.tool_call.planned",
  "mcp.tool_call.started",
  "x402.http.initial_request.sent",
  "x402.http.402_received",
  "x402.payment_required.decoded",
  "x402.payment_requirement.selected",
  "x402.payment_payload.created",
  "x402.http.retry_with_payment_signature.sent",
  "x402.server.payment_signature.received",
  "x402.facilitator.verify.requested",
  "x402.facilitator.verify.succeeded",
  "x402.resource.execution.succeeded",
  "x402.facilitator.settle.requested",
  "x402.facilitator.settle.succeeded",
  "x402.http.200_with_payment_response.received",
  "x402.payment_response.decoded",
  "mcp.tool_call.completed",
  "assistant.explanation.generated",
  "chat.assistant_message.sent",
];

const TERMINAL_SUCCESS_STEP = "chat.assistant_message.sent";
const TERMINAL_FAIL_STEP = "mcp.tool_call.completed";

const MAX_EVENTS = 8000;
const HISTORY_TRACE_LIMIT = 30;
const RATE_WINDOW_MS = 1000;

const state = {
  events: [],
  historyModalOpen: false,
  selectedHistoryTraceId: null,
  selectedHistoryStepKey: null,
  nodeDetails: new Map(),
  renderQueued: false,
  eventRateWindow: [],
};

const el = {
  sseState: document.getElementById("sse-state"),
  totalCount: document.getElementById("total-count"),
  eventRate: document.getElementById("event-rate"),
  historyOpen: document.getElementById("history-open"),
  historyModal: document.getElementById("history-modal"),
  historyClose: document.getElementById("history-close"),
  historyList: document.getElementById("history-list"),
  historyDetailTitle: document.getElementById("history-detail-title"),
  historySteps: document.getElementById("history-steps"),
  historyStepDetail: document.getElementById("history-step-detail"),
};

function normalizeEventStatus(status) {
  const s = String(status || "info").toLowerCase();
  if (s === "success" || s === "fail" || s === "started" || s === "info") {
    return s;
  }
  return "info";
}

function safe(v) {
  if (v === undefined || v === null) return "";
  return String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function compactTime(ts) {
  if (typeof ts !== "string") return "-";
  const i = ts.indexOf("T");
  if (i < 0 || ts.length < i + 2) return ts;
  return ts.slice(i + 1, ts.length - 1);
}

function addEvents(newEvents) {
  state.events.push(...newEvents);
  if (state.events.length > MAX_EVENTS) {
    state.events = state.events.slice(-MAX_EVENTS);
  }
}

function markEventPulse() {
  const now = Date.now();
  state.eventRateWindow.push(now);
  const cutoff = now - RATE_WINDOW_MS;
  while (state.eventRateWindow.length > 0 && state.eventRateWindow[0] < cutoff) {
    state.eventRateWindow.shift();
  }
  if (el.eventRate) {
    el.eventRate.textContent = `${state.eventRateWindow.length}/s`;
  }
}

function refreshEventRate() {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  while (state.eventRateWindow.length > 0 && state.eventRateWindow[0] < cutoff) {
    state.eventRateWindow.shift();
  }
  if (el.eventRate) {
    el.eventRate.textContent = `${state.eventRateWindow.length}/s`;
  }
}

function buildTraceMap() {
  const map = new Map();
  for (let i = 0; i < state.events.length; i += 1) {
    const event = state.events[i];
    if (!event || typeof event.traceId !== "string" || event.traceId.length === 0) continue;
    if (!map.has(event.traceId)) {
      map.set(event.traceId, []);
    }
    map.get(event.traceId).push({ ...event, _index: i });
  }
  return map;
}

function traceStarted(events) {
  return events.some(event => {
    return event.step === "mcp.tool_call.started" || event.step === "x402.http.initial_request.sent";
  });
}

function traceFinished(events) {
  return events.some(event => {
    return (
      (event.step === TERMINAL_SUCCESS_STEP && normalizeEventStatus(event.status) === "success") ||
      (event.step === TERMINAL_FAIL_STEP && normalizeEventStatus(event.status) === "fail")
    );
  });
}

function toNodeStatus(stepEvents) {
  if (!stepEvents || stepEvents.length === 0) return "pending";
  const statuses = stepEvents.map(event => normalizeEventStatus(event.status));
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("success")) return "success";
  if (statuses.includes("started")) return "running";
  if (statuses.includes("info")) return "success";
  return "running";
}

function getStepInfo(events, step) {
  const matched = events.filter(event => event.step === step);
  return {
    step,
    status: toNodeStatus(matched),
    lastEvent: matched.length > 0 ? matched[matched.length - 1] : null,
    events: matched,
  };
}

function statusText(status) {
  if (status === "success") return "成功";
  if (status === "fail") return "失败";
  if (status === "running") return "执行中";
  return "未执行";
}

function computeTraceStatus(events) {
  if (events.length === 0) return "pending";
  const hasFail = events.some(event => normalizeEventStatus(event.status) === "fail");
  if (hasFail) return "fail";
  if (traceFinished(events)) return "success";
  if (traceStarted(events)) return "running";
  return "pending";
}

function getTraceTimeSummary(events) {
  if (events.length === 0) return "no-time";
  const first = events[0];
  const last = events[events.length - 1];
  const firstMs = Date.parse(first.ts || "");
  const lastMs = Date.parse(last.ts || "");
  if (!Number.isNaN(firstMs) && !Number.isNaN(lastMs)) {
    return `${compactTime(first.ts)} -> ${compactTime(last.ts)} (${lastMs - firstMs}ms)`;
  }
  return `${compactTime(first.ts)} -> ${compactTime(last.ts)}`;
}

function listHistoryTraces(traceMap) {
  return Array.from(traceMap.entries())
    .map(([traceId, events]) => {
      const last = events[events.length - 1];
      return { traceId, events, lastIndex: last?._index || 0 };
    })
    .sort((a, b) => b.lastIndex - a.lastIndex)
    .slice(0, HISTORY_TRACE_LIMIT);
}

function makeHistoryStepKey(traceId, step) {
  return `history-step::${traceId}::${step}`;
}

function pickDefaultHistoryStepKey(traceId, events) {
  const infos = FLOW_STEPS.map(step => getStepInfo(events, step));
  const firstReady = infos.find(info => info.status !== "pending");
  const step = firstReady ? firstReady.step : FLOW_STEPS[0];
  return makeHistoryStepKey(traceId, step);
}

function syncHistorySelection(traces, traceMap) {
  if (traces.length === 0) {
    state.selectedHistoryTraceId = null;
    state.selectedHistoryStepKey = null;
    return;
  }

  const hasSelectedTrace = state.selectedHistoryTraceId
    ? traces.some(trace => trace.traceId === state.selectedHistoryTraceId)
    : false;

  if (!hasSelectedTrace) {
    state.selectedHistoryTraceId = traces[0].traceId;
    state.selectedHistoryStepKey = null;
  }

  const selectedEvents = traceMap.get(state.selectedHistoryTraceId) || [];
  if (
    !state.selectedHistoryStepKey ||
    !state.selectedHistoryStepKey.startsWith(`history-step::${state.selectedHistoryTraceId}::`)
  ) {
    state.selectedHistoryStepKey = pickDefaultHistoryStepKey(state.selectedHistoryTraceId, selectedEvents);
  }
}

function pickEventDetail(event) {
  if (!event) return null;
  return {
    ts: event.ts,
    step: event.step,
    status: normalizeEventStatus(event.status),
    component: event.component,
    toolName: event.toolName,
    network: event.network,
    scheme: event.scheme,
    asset: event.asset,
    amount: event.amount,
    payTo: event.payTo,
    txHash: event.txHash,
    durationMs: event.durationMs,
    errorReason: event.errorReason,
    metadata: event.metadata,
  };
}

function renderHistoryList(traces) {
  if (!el.historyList) return;

  if (traces.length === 0) {
    el.historyList.innerHTML = `<li class="muted">暂无历史请求</li>`;
    return;
  }

  el.historyList.innerHTML = traces
    .map(item => {
      const status = computeTraceStatus(item.events);
      const selected = state.selectedHistoryTraceId === item.traceId ? "selected" : "";
      return `
        <li>
          <button type="button" class="history-row ${selected}" data-history-trace="${safe(item.traceId)}">
            <div class="history-row-top">
              <p class="history-row-trace">trace: ${safe(item.traceId)}</p>
              <span class="history-status ${status}">${statusText(status)}</span>
            </div>
            <p class="history-row-meta">${safe(getTraceTimeSummary(item.events))} • events=${item.events.length}</p>
          </button>
        </li>
      `;
    })
    .join("");
}

function renderHistoryDetail(traceMap) {
  if (!el.historyDetailTitle || !el.historySteps || !el.historyStepDetail) return;

  if (!state.selectedHistoryTraceId) {
    el.historyDetailTitle.textContent = "请选择一个历史请求";
    el.historySteps.innerHTML = "";
    el.historyStepDetail.textContent = "-";
    return;
  }

  const events = traceMap.get(state.selectedHistoryTraceId) || [];
  const traceStatus = computeTraceStatus(events);
  el.historyDetailTitle.textContent = `trace: ${state.selectedHistoryTraceId} • ${statusText(traceStatus)}`;

  const infos = FLOW_STEPS.map(step => getStepInfo(events, step));
  el.historySteps.innerHTML = infos
    .map(info => {
      const key = makeHistoryStepKey(state.selectedHistoryTraceId, info.step);
      const isSelected = state.selectedHistoryStepKey === key ? "selected" : "";
      const meta = info.lastEvent
        ? `${compactTime(info.lastEvent.ts)} • ${info.lastEvent.component || "unknown"}`
        : "未执行";

      state.nodeDetails.set(key, {
        title: `${info.step} (${state.selectedHistoryTraceId})`,
        body: [
          `traceId: ${state.selectedHistoryTraceId}`,
          "context: history-modal",
          `step: ${info.step}`,
          `nodeStatus: ${info.status}`,
          `matchedEvents: ${info.events.length}`,
          "",
          "lastEvent:",
          JSON.stringify(pickEventDetail(info.lastEvent), null, 2),
        ].join("\n"),
      });

      return `
        <button type="button" class="history-step ${isSelected}" data-history-step="${safe(key)}">
          <span class="history-step-left">
            <span class="history-step-name">${safe(info.step)}</span>
            <span class="history-step-meta">${safe(meta)}</span>
          </span>
          <span class="step-state ${info.status}">${statusText(info.status)}</span>
        </button>
      `;
    })
    .join("");

  const detail = state.selectedHistoryStepKey
    ? state.nodeDetails.get(state.selectedHistoryStepKey)
    : null;
  el.historyStepDetail.textContent = detail?.body || "-";
}

function renderHistoryModal(traceMap) {
  const traces = listHistoryTraces(traceMap);
  syncHistorySelection(traces, traceMap);
  renderHistoryList(traces);
  renderHistoryDetail(traceMap);

  if (!el.historyModal) return;
  if (state.historyModalOpen) {
    el.historyModal.classList.remove("hidden");
  } else {
    el.historyModal.classList.add("hidden");
  }
}

function renderNow() {
  refreshEventRate();
  state.nodeDetails.clear();
  if (el.totalCount) {
    el.totalCount.textContent = String(state.events.length);
  }
  const traceMap = buildTraceMap();
  renderHistoryModal(traceMap);
}

function requestRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  const schedule =
    typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : callback => setTimeout(callback, 16);
  schedule(() => {
    state.renderQueued = false;
    renderNow();
  });
}

function openHistoryModal() {
  state.historyModalOpen = true;
  if (el.historyModal) {
    el.historyModal.classList.remove("hidden");
  }
}

function closeHistoryModal() {
  state.historyModalOpen = false;
  if (el.historyModal) {
    el.historyModal.classList.add("hidden");
  }
}

function bindEvents() {
  document.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const historyOpenBtn = target.closest("#history-open");
    if (el.historyOpen && historyOpenBtn === el.historyOpen) {
      openHistoryModal();
      requestRender();
      return;
    }

    const historyCloseBtn = target.closest("#history-close");
    if (el.historyClose && historyCloseBtn === el.historyClose) {
      closeHistoryModal();
      return;
    }

    if (el.historyModal && target === el.historyModal) {
      closeHistoryModal();
      return;
    }

    const historyTraceBtn = target.closest("[data-history-trace]");
    if (historyTraceBtn) {
      const traceId = historyTraceBtn.getAttribute("data-history-trace");
      if (!traceId) return;
      state.selectedHistoryTraceId = traceId;
      state.selectedHistoryStepKey = null;
      requestRender();
      return;
    }

    const historyStepBtn = target.closest("[data-history-step]");
    if (historyStepBtn) {
      const stepKey = historyStepBtn.getAttribute("data-history-step");
      if (!stepKey) return;
      state.selectedHistoryStepKey = stepKey;
      requestRender();
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && state.historyModalOpen) {
      closeHistoryModal();
    }
  });
}

async function boot() {
  bindEvents();

  setInterval(() => {
    refreshEventRate();
  }, 250);

  const initial = await fetch("/events?limit=1000");
  const payload = await initial.json();
  addEvents(payload.events || []);
  requestRender();

  const source = new EventSource("/events/stream");
  if (el.sseState) {
    el.sseState.textContent = "LIVE";
  }

  source.onopen = () => {
    if (el.sseState) {
      el.sseState.textContent = "LIVE";
    }
  };

  source.onerror = () => {
    if (el.sseState) {
      el.sseState.textContent = "RETRY";
    }
  };

  source.addEventListener("snapshot", event => {
    const snapshot = JSON.parse(event.data);
    state.events = Array.isArray(snapshot) ? snapshot : [];
    requestRender();
  });

  source.addEventListener("event", event => {
    const parsed = JSON.parse(event.data);
    markEventPulse();
    addEvents([parsed]);
    requestRender();
  });
}

void boot();
