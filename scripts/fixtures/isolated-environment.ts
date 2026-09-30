import { testProcessEnvironment } from '../../tests/fixtures/process-environment.js';

// These command-line exercises only operate on disposable local copies. Load
// this before application modules so their parent-side auth fixtures are also isolated.
const environment = testProcessEnvironment();
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, environment);
