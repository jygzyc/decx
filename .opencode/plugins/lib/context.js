class PluginContext {
  init(input, sessionManager) {
    this.client = input?.client ?? null;
    this.directory = input?.directory ?? null;
    this.sessionManager = sessionManager;
  }
}

export const ctx = new PluginContext();
