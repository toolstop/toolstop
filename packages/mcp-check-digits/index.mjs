#!/usr/bin/env node
import { runStdio } from "../_shared/stdio.mjs";
import server from "./tools.mjs";

await runStdio(server);
