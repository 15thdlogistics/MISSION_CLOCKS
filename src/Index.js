export class Mission_Clocks {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.initialized = false;
  }

  // ====== ROUTER ======
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      return this.initialize(request);
    }

    if (url.pathname === "/register-document" && request.method === "POST") {
      return this.registerDocument(request);
    }

    if (url.pathname === "/cancel" && request.method === "POST") {
      return this.cancelAll();
    }

    return new Response("Not Found", { status: 404 });
  }

  // ====== INITIALIZE MISSION CLOCK ======
  async initialize(request) {
    const body = await request.json();

    const {
      missionId,
      departureTime,
      t72LockTime,
      t48LockTime,
      slaDeadlines = [],
      documentExpirations = []
    } = body;

    if (!missionId) {
      return new Response("missionId required", { status: 400 });
    }

    const triggers = [];

    if (t72LockTime) {
      triggers.push({ type: "T72_LOCK", time: t72LockTime });
    }

    if (t48LockTime) {
      triggers.push({ type: "T48_LOCK", time: t48LockTime });
    }

    for (const sla of slaDeadlines) {
      triggers.push({ type: "SLA_BREACH", time: sla.time, meta: sla.meta });
    }

    for (const doc of documentExpirations) {
      triggers.push({
        type: "DOCUMENT_EXPIRED",
        time: doc.expiry,
        meta: { documentId: doc.documentId }
      });
    }

    // Sort triggers by time ascending
    triggers.sort((a, b) => new Date(a.time) - new Date(b.time));

    await this.state.storage.put("missionId", missionId);
    await this.state.storage.put("triggers", triggers);

    await this.scheduleNextAlarm();

    this.initialized = true;

    return new Response(JSON.stringify({ status: "initialized" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // ====== REGISTER DOCUMENT EXPIRY AFTER INIT ======
  async registerDocument(request) {
    const body = await request.json();
    const { documentId, expiry } = body;

    const triggers = (await this.state.storage.get("triggers")) || [];

    triggers.push({
      type: "DOCUMENT_EXPIRED",
      time: expiry,
      meta: { documentId }
    });

    triggers.sort((a, b) => new Date(a.time) - new Date(b.time));

    await this.state.storage.put("triggers", triggers);

    await this.scheduleNextAlarm();

    return new Response(JSON.stringify({ status: "registered" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // ====== CANCEL ALL TIMERS ======
  async cancelAll() {
    await this.state.storage.delete("triggers");
    await this.state.storage.deleteAll();
    return new Response(JSON.stringify({ status: "cancelled" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // ====== ALARM HANDLER ======
  async alarm() {
    const missionId = await this.state.storage.get("missionId");
    let triggers = (await this.state.storage.get("triggers")) || [];

    if (!triggers.length) {
      return;
    }

    const now = Date.now();

    const dueTriggers = triggers.filter(
      (t) => new Date(t.time).getTime() <= now
    );

    if (!dueTriggers.length) {
      await this.scheduleNextAlarm();
      return;
    }

    // Execute all due triggers
    for (const trigger of dueTriggers) {
      await this.emitTrigger(missionId, trigger);
    }

    // Remove executed triggers
    triggers = triggers.filter(
      (t) => new Date(t.time).getTime() > now
    );

    await this.state.storage.put("triggers", triggers);

    await this.scheduleNextAlarm();
  }

  // ====== EMIT EVENT TO GOVERNANCE ======
  async emitTrigger(missionId, trigger) {
    try {
      await fetch(this.env["mission-control-api"], {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          missionId,
          eventType: trigger.type,
          meta: trigger.meta || {}
        })
      });

      // Optional notification dispatch
      await fetch(this.env["mission-comms"], {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          missionId,
          notificationType: trigger.type
        })
      });

    } catch (err) {
      console.error("Trigger emission failed:", err);
    }
  }

  // ====== SCHEDULE NEXT ALARM ======
  async scheduleNextAlarm() {
    const triggers = (await this.state.storage.get("triggers")) || [];

    if (!triggers.length) {
      return;
    }

    const nextTrigger = triggers[0];
    const nextTime = new Date(nextTrigger.time).getTime();

    if (nextTime > Date.now()) {
      await this.state.storage.setAlarm(nextTime);
    } else {
      await this.state.storage.setAlarm(Date.now() + 1000);
    }
  }
        }
