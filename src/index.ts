import { MetaMaskAndroidGlue } from "./glue.js";
import { logger } from "./logger.js";
import serveGlue, { ServeResult } from "@wallet-test-framework/glue-ws";
import meow from "meow";
import * as process from "node:process";

async function serve(
    baseUrl: string,
    implementation: MetaMaskAndroidGlue,
    serveResult: ServeResult,
): Promise<void> {
    let glueUrl: string;

    if (typeof serveResult.address === "string") {
        throw new Error("not implemented"); // TODO
    } else {
        const host =
            serveResult.address.family === "IPv6" ? "[::1]" : "127.0.0.1";
        glueUrl = `ws://${host}:3001/`;
    }

    const parsedUrl = new URL(baseUrl);
    parsedUrl.hash = `#glue=${glueUrl}`;

    await implementation.launch(parsedUrl.toString());
}

export async function main(args: string[]): Promise<void> {
    const cli = meow({
        argv: args.slice(2),
        importMeta: import.meta,
        flags: {
            testUrl: {
                type: "string",
                default: "https://wallet-test-framework.herokuapp.com/",
            },
        },
    });

    const implementation = new MetaMaskAndroidGlue();
    const serveResult = serveGlue(implementation, { port: 3001 });

    try {
        await serve(cli.flags.testUrl, implementation, serveResult);
        const report = await implementation.reportReady;

        if (typeof report.value !== "string") {
            throw new Error("unsupported report type");
        }

        process.stdout.write(report.value);
    } finally {
        await serveResult.close();
    }
}

export function mainSync(args: string[]): void {
    main(args).catch((e) => {
        logger.error(e);
        process.exit(1);
    });
}
