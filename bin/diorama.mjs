#!/usr/bin/env node
// Loads the TypeScript sources through tsx, so the CLI runs straight from a git checkout.
import { register } from 'tsx/esm/api';

register();
await import('../src/main.ts');
