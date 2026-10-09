import { syncBuiltinESMExports } from 'node:module';
import type { TestContext } from 'node:test';

export function restoreBuiltins(context: TestContext): void {
  context.mock.restoreAll();
  syncBuiltinESMExports();
}

/** Keep builtin namespace bindings in sync with mocks of Node's default object. */
export function mockBuiltin(context: TestContext): TestContext['mock']['method'] {
  return ((...args: unknown[]) => {
    const result = Reflect.apply(context.mock.method, context.mock, args);
    syncBuiltinESMExports();
    context.after(() => {
      result.mock.restore();
      syncBuiltinESMExports();
    });
    return result;
  }) as TestContext['mock']['method'];
}
