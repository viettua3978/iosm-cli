#!/usr/bin/env node
/**
 * CLI entry point for the iosm CLI.
 *
 * Test with: npx tsx src/cli.ts [args...]
 */
process.title = "iosm";

import { setBedrockProviderModule } from "@mariozechner/pi-ai";
import { bedrockProviderModule } from "@mariozechner/pi-ai/bedrock-provider";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { main } from "./main.js";

setGlobalDispatcher(new EnvHttpProxyAgent());
setBedrockProviderModule(bedrockProviderModule);

main(process.argv.slice(2));
