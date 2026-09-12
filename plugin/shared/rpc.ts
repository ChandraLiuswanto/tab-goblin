import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const pingRpc = defineRpc({
  name: "tabgoblin.ping",
  input: z.object({}),
  output: z.object({ protocolVersion: z.number().int() }),
});
