import { createFetchHandler } from "../_shared/http.mjs";
import server from "./tools.mjs";

export default { fetch: createFetchHandler(server) };
