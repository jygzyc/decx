export class SessionData {
  constructor(agentName = "unknown") {
    this.createdAt = Date.now();
    this.lastUserMessageAt = this.createdAt;
    this.agentName = agentName;
    this.agentSwitchedFrom = null;
    this.systemTransformCount = 0;
  }
}

export class SessionDataManager {
  constructor() {
    this.sessions = new Map();
  }

  upsert(sessionID, agentName = "unknown") {
    let session = this.sessions.get(sessionID);
    if (!session) {
      session = new SessionData(agentName);
      this.sessions.set(sessionID, session);
      return session;
    }
    session.lastUserMessageAt = Date.now();
    if (agentName && session.agentName !== agentName) {
      session.agentSwitchedFrom = session.agentName;
      session.agentName = agentName;
    }
    return session;
  }

  get(sessionID) {
    return this.sessions.get(sessionID);
  }

  delete(sessionID) {
    this.sessions.delete(sessionID);
  }
}
