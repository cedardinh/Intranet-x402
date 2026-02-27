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

const SEQUENCE_ACTORS = [
  { id: "client", label: "Client" },
  { id: "server", label: "Server" },
  { id: "facilitator", label: "Facilitator" },
  { id: "blockchain", label: "Blockchain" },
];

const SEQUENCE_MESSAGES = [
  {
    id: "initial-request",
    step: "x402.http.initial_request.sent",
    from: "client",
    to: "server",
    label: "GET /api",
    detail: "Client 发起受保护资源请求",
  },
  {
    id: "payment-required",
    step: "x402.http.402_received",
    from: "server",
    to: "client",
    label: "402 PAYMENT-REQUIRED: {..}",
    detail: "Server 返回支付要求",
  },
  {
    id: "create-payload",
    step: "x402.payment_payload.created",
    from: "client",
    to: "client",
    label: "Create payment payload",
    detail: "Client 生成支付签名载荷",
  },
  {
    id: "retry-with-signature",
    step: "x402.http.retry_with_payment_signature.sent",
    from: "client",
    to: "server",
    label: "GET /api\nPAYMENT-SIGNATURE: {..}",
    detail: "Client 携带 PAYMENT-SIGNATURE 重试请求",
  },
  {
    id: "verify-requested",
    step: "x402.facilitator.verify.requested",
    from: "server",
    to: "facilitator",
    label: "POST /verify\nPAYMENT-SIGNATURE\nPAYMENT-REQUIRED",
    detail: "Server 请求 Facilitator 校验支付",
  },
  {
    id: "verify-succeeded",
    step: "x402.facilitator.verify.succeeded",
    from: "facilitator",
    to: "server",
    label: "200 Verification",
    detail: "Facilitator 返回校验通过结果",
  },
  {
    id: "server-work",
    step: "x402.resource.execution.succeeded",
    from: "server",
    to: "server",
    label: "Do work",
    detail: "Server 执行业务逻辑",
  },
  {
    id: "settle-requested",
    step: "x402.facilitator.settle.requested",
    from: "server",
    to: "facilitator",
    label: "POST /settle\nPAYMENT-SIGNATURE\nPAYMENT-REQUIRED",
    detail: "Server 请求 Facilitator 执行结算",
  },
  {
    id: "submit-tx",
    step: "x402.facilitator.settle.requested",
    from: "facilitator",
    to: "blockchain",
    label: "Submit tx",
    detail: "Facilitator 向链上提交结算交易",
  },
  {
    id: "tx-confirmed",
    step: "x402.facilitator.settle.succeeded",
    from: "blockchain",
    to: "facilitator",
    label: "tx confirmed",
    detail: "Blockchain 返回交易确认",
  },
  {
    id: "settle-succeeded",
    step: "x402.facilitator.settle.succeeded",
    from: "facilitator",
    to: "server",
    label: "200 Settled + tx_hash",
    detail: "Facilitator 回传结算结果与交易哈希",
  },
  {
    id: "response-200",
    step: "x402.http.200_with_payment_response.received",
    from: "server",
    to: "client",
    label: "200 OK\nPAYMENT-RESPONSE\nContent",
    detail: "Server 返回最终业务内容",
  },
];

const ACTOR_INDEX = new Map(SEQUENCE_ACTORS.map((actor, index) => [actor.id, index]));

const TERMINAL_SUCCESS_STEP = "chat.assistant_message.sent";
const TERMINAL_FAIL_STEP = "mcp.tool_call.completed";

const TYPING_DELAY_MS = 11;
const MAX_EVENTS = 8000;
const MAX_STREAM_CHARS = 18000;
const HISTORY_TRACE_LIMIT = 30;
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const STATUS_FLASH_MS = 520;
const RATE_WINDOW_MS = 1000;

const state = {
  events: [],
  activeTraceId: null,
  streamQueue: [],
  streaming: false,
  streamGeneration: 0,
  nodeDetails: new Map(),
  selectedNode: null,
  historyModalOpen: false,
  selectedHistoryTraceId: null,
  selectedHistoryStepKey: null,
  sequenceStatusCache: new Map(),
  changedSequenceKeys: new Set(),
  changedSequenceTimer: null,
  renderQueued: false,
  eventRateWindow: [],
};

const el = {
  sseState: document.getElementById("sse-state"),
  streamState: document.getElementById("stream-state"),
  totalCount: document.getElementById("total-count"),
  activeTrace: document.getElementById("active-trace"),
  eventRate: document.getElementById("event-rate"),
  realtimeSection: document.getElementById("realtime-section"),
  flowNodes: document.getElementById("flow-nodes"),
  currentStep: document.getElementById("current-step"),
  currentDetail: document.getElementById("current-detail"),
  streamOutput: document.getElementById("stream-output"),
  historyOpen: document.getElementById("history-open"),
  historyModal: document.getElementById("history-modal"),
  historyClose: document.getElementById("history-close"),
  historyList: document.getElementById("history-list"),
  historyDetailTitle: document.getElementById("history-detail-title"),
  historySteps: document.getElementById("history-steps"),
  historyStepDetail: document.getElementById("history-step-detail"),
};

function wait(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function normalizeEventStatus(status) {
  const s = String(status || "info").toLowerCase();
  if (s === "success" || s === "fail" || s === "started" || s === "info") {
    return s;
  }
  return "info";
}

function toShortTrace(traceId) {
  if (!traceId) return "-";
  return traceId.length > 12 ? `${traceId.slice(0, 12)}...` : traceId;
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

function clearStreamWindow() {
  el.streamOutput.textContent = "";
}

function keepStreamTail() {
  const text = el.streamOutput.textContent || "";
  if (text.length <= MAX_STREAM_CHARS) return;
  el.streamOutput.textContent = text.slice(text.length - MAX_STREAM_CHARS);
}

function formatLine(event) {
  const parts = [
    `[${compactTime(event.ts)}]`,
    `[${event.component || "unknown"}]`,
    `${event.step || "unknown.step"}`,
    `status=${normalizeEventStatus(event.status)}`,
    `trace=${toShortTrace(event.traceId || "")}`,
  ];
  if (event.network) parts.push(`network=${event.network}`);
  if (event.scheme) parts.push(`scheme=${event.scheme}`);
  if (event.durationMs !== undefined) parts.push(`durationMs=${event.durationMs}`);
  if (event.errorReason) parts.push(`error=${event.errorReason}`);
  return parts.join(" ");
}

async function typeLine(line, generation) {
  const text = `${line}\n`;
  for (const ch of text) {
    if (generation !== state.streamGeneration) {
      return false;
    }
    el.streamOutput.textContent += ch;
    keepStreamTail();
    el.streamOutput.scrollTop = el.streamOutput.scrollHeight;
    await wait(TYPING_DELAY_MS);
  }
  return true;
}

async function drainQueue() {
  if (state.streaming) return;
  state.streaming = true;
  const generation = state.streamGeneration;
  if (state.streamQueue.length > 0) {
    el.streamState.textContent = "TYPING";
  }

  while (state.streamQueue.length > 0) {
    if (generation !== state.streamGeneration) break;
    const line = state.streamQueue.shift();
    if (!line) continue;
    const ok = await typeLine(line, generation);
    if (!ok) break;
  }

  if (generation === state.streamGeneration) {
    el.streamState.textContent = "LIVE";
  }
  state.streaming = false;
}

function enqueueEventLine(event) {
  if (!state.activeTraceId) return;
  if (event.traceId !== state.activeTraceId) return;
  state.streamQueue.push(formatLine(event));
  void drainQueue();
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

function makeSequenceStateKey(traceId, contextTag, sequenceId) {
  return `${contextTag}::${traceId}::${sequenceId}`;
}

function markSequenceStatus(sequenceKey, status) {
  const prev = state.sequenceStatusCache.get(sequenceKey);
  if (prev === undefined) {
    state.sequenceStatusCache.set(sequenceKey, status);
    if (status !== "pending") {
      state.changedSequenceKeys.add(sequenceKey);
    }
    return state.changedSequenceKeys.has(sequenceKey);
  }

  if (prev !== status) {
    state.sequenceStatusCache.set(sequenceKey, status);
    state.changedSequenceKeys.add(sequenceKey);
  }

  return state.changedSequenceKeys.has(sequenceKey);
}

function scheduleChangedSequenceReset() {
  if (state.changedSequenceTimer !== null) {
    clearTimeout(state.changedSequenceTimer);
    state.changedSequenceTimer = null;
  }
  if (state.changedSequenceKeys.size === 0) return;

  state.changedSequenceTimer = setTimeout(() => {
    state.changedSequenceTimer = null;
    if (state.changedSequenceKeys.size === 0) return;
    state.changedSequenceKeys.clear();
    requestRender();
  }, STATUS_FLASH_MS);
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

function pickActiveTrace(traceMap) {
  const now = Date.now();
  const active = [];
  for (const [traceId, events] of traceMap.entries()) {
    if (!traceStarted(events)) continue;
    if (traceFinished(events)) continue;
    const last = events[events.length - 1];
    const lastMs = Date.parse(last?.ts || "");
    if (!Number.isNaN(lastMs) && now - lastMs > ACTIVE_WINDOW_MS) {
      continue;
    }
    active.push({ traceId, lastIndex: last?._index || 0 });
  }

  if (active.length === 0) return null;

  active.sort((a, b) => b.lastIndex - a.lastIndex);
  if (state.activeTraceId && active.some(item => item.traceId === state.activeTraceId)) {
    return state.activeTraceId;
  }
  return active[0].traceId;
}

function summarizeCurrentNode(event) {
  if (!event) {
    return { title: "-", detail: "-" };
  }

  const detail = [
    `status=${normalizeEventStatus(event.status)}`,
    `component=${event.component || "unknown"}`,
    `time=${event.ts || "-"}`,
  ];
  if (event.network) detail.push(`network=${event.network}`);
  if (event.scheme) detail.push(`scheme=${event.scheme}`);
  if (event.asset) detail.push(`asset=${event.asset}`);
  if (event.amount) detail.push(`amount=${event.amount}`);
  if (event.payTo) detail.push(`payTo=${event.payTo}`);
  if (event.txHash) detail.push(`txHash=${event.txHash}`);
  if (event.errorReason) detail.push(`error=${event.errorReason}`);

  return {
    title: event.step || "-",
    detail: detail.join("\n"),
  };
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

function getSequenceInfo(events, message) {
  const matched = events.filter(event => event.step === message.step);
  return {
    ...message,
    status: toNodeStatus(matched),
    events: matched,
    lastEvent: matched.length > 0 ? matched[matched.length - 1] : null,
  };
}

function resolveLinkStatus(currentStatus, nextStatus) {
  if (currentStatus === "fail" || nextStatus === "fail") return "fail";
  if (currentStatus === "running") return "running";
  if (currentStatus === "success" && nextStatus === "pending") return "running";
  if (currentStatus === "success") return "success";
  if (currentStatus === "pending" && nextStatus !== "pending") return "running";
  return "pending";
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
  return makeNodeKey(traceId, "history-step", step);
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

function makeNodeKey(traceId, contextTag, step) {
  return `${contextTag}::${traceId}::${step}`;
}

function registerNodeDetail(key, detail) {
  state.nodeDetails.set(key, detail);
  return key;
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

function renderSvgMultilineText(text, x, y, className, anchor = "middle") {
  const lines = String(text || "")
    .split("\n")
    .filter(line => line.length > 0);
  if (lines.length === 0) return "";

  const tspans = lines
    .map((line, idx) => {
      const dy = idx === 0 ? 0 : 12;
      return `<tspan x="${x}" dy="${dy}">${safe(line)}</tspan>`;
    })
    .join("");

  return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${className}">${tspans}</text>`;
}

function renderSequenceLane(traceId, events, contextTag, emptyText) {
  const infos = SEQUENCE_MESSAGES.map(message => getSequenceInfo(events, message));

  const actorGap = 240;
  const marginX = 52;
  const actorY = 30;
  const lifelineTop = 48;
  const messageStartY = 116;
  const rowGap = 62;
  const loopWidth = 48;
  const loopHeight = 26;

  const actorXs = SEQUENCE_ACTORS.map((_, index) => marginX + index * actorGap);
  const facilitatorX = actorXs[ACTOR_INDEX.get("facilitator") || 2];
  const canvasWidth = marginX * 2 + actorGap * (SEQUENCE_ACTORS.length - 1);
  const lifelineBottom = messageStartY + rowGap * (infos.length - 1) + 42;
  const canvasHeight = lifelineBottom + 42;

  const actorLabels = SEQUENCE_ACTORS.map((actor, idx) => {
    return `<text x="${actorXs[idx]}" y="${actorY}" text-anchor="middle" class="seq-actor-label">${safe(actor.label)}</text>`;
  }).join("");

  const note = renderSvgMultilineText(
    "Note:\nFacilitator is optional;\nverify/settle can be\nhandled by server",
    facilitatorX + 18,
    44,
    "seq-note",
    "start",
  );

  const lifelines = actorXs
    .map(x => `<line x1="${x}" y1="${lifelineTop}" x2="${x}" y2="${lifelineBottom}" class="seq-lifeline" />`)
    .join("");

  const rows = infos.map((info, idx) => {
    const fromIdx = ACTOR_INDEX.get(info.from);
    const toIdx = ACTOR_INDEX.get(info.to);
    if (fromIdx === undefined || toIdx === undefined) return "";

    const fromX = actorXs[fromIdx];
    const toX = actorXs[toIdx];
    const y = messageStartY + idx * rowGap;
    const key = makeNodeKey(traceId, contextTag, `sequence-${info.id}`);
    const sequenceStateKey = makeSequenceStateKey(traceId, contextTag, info.id);
    const changedClass = markSequenceStatus(sequenceStateKey, info.status) ? "just-updated" : "";
    const isSelected = state.selectedNode?.key === key;
    const meta = info.lastEvent
      ? `${compactTime(info.lastEvent.ts)} • ${info.lastEvent.component || "unknown"}`
      : emptyText;
    const eventDetail = info.lastEvent
      ? JSON.stringify(pickEventDetail(info.lastEvent), null, 2)
      : "null";

    registerNodeDetail(key, {
      title: `${info.label} (${traceId})`,
      body: [
        `traceId: ${traceId}`,
        `context: ${contextTag}`,
        `messageId: ${info.id}`,
        `step: ${info.step}`,
        `flow: ${info.from} -> ${info.to}`,
        `messageStatus: ${info.status}`,
        `matchedEvents: ${info.events.length}`,
        `description: ${info.detail}`,
        "",
        "lastEvent:",
        eventDetail,
      ].join("\n"),
    });

    if (fromIdx === toIdx) {
      const path = `M ${fromX} ${y} h ${loopWidth} v ${loopHeight} h -${loopWidth - 12}`;
      const arrow = `${fromX},${y + loopHeight} ${fromX + 12},${y + loopHeight - 6} ${fromX + 12},${y + loopHeight + 6}`;
      const hitX = fromX - 16;
      const hitY = y - 16;
      const hitW = loopWidth + 22;
      const hitH = loopHeight + 28;
      const label = renderSvgMultilineText(info.label, fromX + loopWidth / 2, y - 10, "seq-message-label");
      const metaText = renderSvgMultilineText(meta, fromX + loopWidth / 2, y + loopHeight + 13, "seq-message-meta");

      return `
        <g
          class="seq-message-node ${info.status} ${changedClass} ${isSelected ? "selected" : ""}"
          data-node-key="${safe(key)}"
          data-trace-id="${safe(traceId)}"
          data-context-tag="${safe(contextTag)}"
        >
          <rect class="seq-hitbox" x="${hitX}" y="${hitY}" width="${hitW}" height="${hitH}" rx="8" />
          <path d="${path}" class="seq-message-loop" />
          <polygon points="${arrow}" class="seq-message-arrow" />
          ${label}
          ${metaText}
        </g>
      `;
    }

    const forward = toX > fromX;
    const lineEnd = forward ? toX - 10 : toX + 10;
    const arrow = forward
      ? `${toX},${y} ${toX - 10},${y - 5} ${toX - 10},${y + 5}`
      : `${toX},${y} ${toX + 10},${y - 5} ${toX + 10},${y + 5}`;
    const hitX = Math.min(fromX, toX) - 10;
    const hitW = Math.abs(toX - fromX) + 20;
    const hitY = y - 20;
    const hitH = 38;
    const labelX = (fromX + toX) / 2;
    const label = renderSvgMultilineText(info.label, labelX, y - 10, "seq-message-label");
    const metaText = renderSvgMultilineText(meta, labelX, y + 14, "seq-message-meta");

    return `
      <g
        class="seq-message-node ${info.status} ${changedClass} ${isSelected ? "selected" : ""}"
        data-node-key="${safe(key)}"
        data-trace-id="${safe(traceId)}"
        data-context-tag="${safe(contextTag)}"
      >
        <rect class="seq-hitbox" x="${hitX}" y="${hitY}" width="${hitW}" height="${hitH}" rx="8" />
        <line x1="${fromX}" y1="${y}" x2="${lineEnd}" y2="${y}" class="seq-message-line" />
        <polygon points="${arrow}" class="seq-message-arrow" />
        ${label}
        ${metaText}
      </g>
    `;
  }).join("");

  return `
    <div class="sequence-shell">
      <div class="sequence-scroll">
        <svg class="sequence-svg" viewBox="0 0 ${canvasWidth} ${canvasHeight}" preserveAspectRatio="xMinYMin meet">
          ${actorLabels}
          ${note}
          ${lifelines}
          ${rows}
        </svg>
      </div>
    </div>
  `;
}

function renderNodeDrawer(traceId, contextTag) {
  if (!state.selectedNode) return "";
  if (state.selectedNode.traceId !== traceId || state.selectedNode.contextTag !== contextTag) return "";
  const detail = state.nodeDetails.get(state.selectedNode.key);
  if (!detail) return "";

  return `
    <section class="node-drawer">
      <div class="node-drawer-head">
        <h3 class="node-drawer-title">${safe(detail.title)}</h3>
        <button type="button" class="drawer-close" data-drawer-close="1">收起</button>
      </div>
      <pre class="node-drawer-body">${safe(detail.body)}</pre>
    </section>
  `;
}

function renderFlowRow(traceId, events, contextTag, rowTitlePrefix) {
  const status = computeTraceStatus(events);
  const timeSummary = getTraceTimeSummary(events);
  const stepCount = events.length;
  const lane = renderSequenceLane(traceId, events, contextTag, "未执行");
  const drawer = renderNodeDrawer(traceId, contextTag);

  return `
    <article class="flow-row">
      <div class="flow-row-head">
        <div>
          <p class="flow-row-trace">${safe(rowTitlePrefix)} ${safe(traceId)}</p>
          <p class="flow-row-meta">${safe(timeSummary)} • events=${stepCount}</p>
        </div>
        <span class="history-status ${status}">${statusText(status)}</span>
      </div>
      ${lane}
      ${drawer}
    </article>
  `;
}

function activateTrace(traceId) {
  if (state.activeTraceId === traceId) return;
  state.activeTraceId = traceId;
  state.streamGeneration += 1;
  state.streamQueue = [];
  state.streaming = false;
  clearStreamWindow();
  el.streamState.textContent = "LIVE";
}

function deactivateRealtime() {
  if (state.activeTraceId !== null) {
    state.activeTraceId = null;
    state.streamGeneration += 1;
    state.streamQueue = [];
    state.streaming = false;
  }
  if (state.selectedNode && state.selectedNode.contextTag === "realtime") {
    state.selectedNode = null;
  }
  el.activeTrace.textContent = "-";
  el.realtimeSection.classList.add("hidden");
  el.currentStep.textContent = "-";
  el.currentDetail.textContent = "-";
  clearStreamWindow();
  el.streamState.textContent = "IDLE";
  el.flowNodes.innerHTML = "";
}

function renderRealtime(traceMap) {
  const activeTraceId = pickActiveTrace(traceMap);
  if (!activeTraceId) {
    deactivateRealtime();
    return;
  }

  const traceEvents = traceMap.get(activeTraceId) || [];
  activateTrace(activeTraceId);
  el.activeTrace.textContent = toShortTrace(activeTraceId);
  el.realtimeSection.classList.remove("hidden");
  el.flowNodes.innerHTML = renderFlowRow(activeTraceId, traceEvents, "realtime", "trace:");

  const current = summarizeCurrentNode(traceEvents[traceEvents.length - 1]);
  el.currentStep.textContent = current.title;
  el.currentDetail.textContent = current.detail;
  if (!state.streaming && state.streamQueue.length === 0) {
    el.streamState.textContent = "LIVE";
  }
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

      registerNodeDetail(key, {
        title: `${info.step} (${state.selectedHistoryTraceId})`,
        body: [
          `traceId: ${state.selectedHistoryTraceId}`,
          `context: history-modal`,
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

function pruneSequenceState(traceMap) {
  const traceIds = new Set(traceMap.keys());
  for (const key of state.sequenceStatusCache.keys()) {
    const parts = key.split("::");
    const traceId = parts[1];
    if (traceId && !traceIds.has(traceId)) {
      state.sequenceStatusCache.delete(key);
      state.changedSequenceKeys.delete(key);
    }
  }
}

function renderNow() {
  refreshEventRate();
  state.nodeDetails.clear();
  el.totalCount.textContent = String(state.events.length);
  const traceMap = buildTraceMap();
  pruneSequenceState(traceMap);
  if (state.selectedNode && !traceMap.has(state.selectedNode.traceId)) {
    state.selectedNode = null;
  }
  renderRealtime(traceMap);
  renderHistoryModal(traceMap);
  scheduleChangedSequenceReset();
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

function bindNodeEvents() {
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
      return;
    }

    const drawerClose = target.closest("[data-drawer-close]");
    if (drawerClose) {
      state.selectedNode = null;
      requestRender();
      return;
    }

    const nodeBtn = target.closest("[data-node-key]");
    if (!nodeBtn) {
      return;
    }

    const key = nodeBtn.getAttribute("data-node-key");
    const traceId = nodeBtn.getAttribute("data-trace-id");
    const contextTag = nodeBtn.getAttribute("data-context-tag");
    if (!key || !traceId || !contextTag) return;

    if (
      state.selectedNode &&
      state.selectedNode.key === key &&
      state.selectedNode.traceId === traceId &&
      state.selectedNode.contextTag === contextTag
    ) {
      state.selectedNode = null;
    } else {
      state.selectedNode = { key, traceId, contextTag };
    }
    requestRender();
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (state.historyModalOpen) {
        closeHistoryModal();
        return;
      }
      if (state.selectedNode) {
        state.selectedNode = null;
        requestRender();
      }
    }
  });
}

async function boot() {
  bindNodeEvents();
  setInterval(() => {
    refreshEventRate();
  }, 250);
  const initial = await fetch("/events?limit=1000");
  const payload = await initial.json();
  addEvents(payload.events || []);
  requestRender();

  const source = new EventSource("/events/stream");
  el.sseState.textContent = "LIVE";

  source.onopen = () => {
    el.sseState.textContent = "LIVE";
  };

  source.onerror = () => {
    el.sseState.textContent = "RETRY";
  };

  source.addEventListener("snapshot", event => {
    const snapshot = JSON.parse(event.data);
    state.events = Array.isArray(snapshot) ? snapshot : [];
    state.streamGeneration += 1;
    state.streamQueue = [];
    state.streaming = false;
    clearStreamWindow();
    requestRender();
  });

  source.addEventListener("event", event => {
    const parsed = JSON.parse(event.data);
    const previousActiveTrace = state.activeTraceId;
    markEventPulse();
    addEvents([parsed]);
    requestRender();

    if (previousActiveTrace === state.activeTraceId) {
      enqueueEventLine(parsed);
    } else if (parsed.traceId === state.activeTraceId) {
      enqueueEventLine(parsed);
    }
  });
}

void boot();
