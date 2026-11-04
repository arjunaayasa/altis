import { z } from 'zod';

// Imported for its side effect only, as the FIRST import of main.tsx (spec §7.4, exit check A11). Zod compiles object
// parsers with `new Function` unless it is jitless, and its probe for that (a `new Function` inside a try/catch) is
// still reported by the browser as a `script-src` violation under a policy without 'unsafe-eval', which the admin's
// policy never has. Jitless parsing needs no eval. Being the first import, this runs before any module that could build
// a schema (an ES module's body runs only after the bodies of the modules it imports).
z.config({ jitless: true });
