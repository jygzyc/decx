import {
  ensureDecxTestDirs,
  DECX_TEST_DECX_HOME,
  DECX_TEST_HOME,
  DECX_TEST_ROOT,
  DECX_TEST_SERVER_HOME,
} from "./test-paths.js";

ensureDecxTestDirs();

process.env.HOME = DECX_TEST_HOME;
process.env.USERPROFILE = DECX_TEST_HOME;
process.env.DECX_HOME = DECX_TEST_DECX_HOME;
process.env.DECX_SERVER_HOME = DECX_TEST_SERVER_HOME;
process.env.DECX_TEST_ROOT = DECX_TEST_ROOT;
