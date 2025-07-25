import { AllureReport, isFileNotFoundError, readConfig } from "@allurereport/core";
import { newFilesInDirectoryWatcher } from "@allurereport/directory-watcher";
import Awesome from "@allurereport/plugin-awesome";
import ProgressPlugin from "@allurereport/plugin-progress";
import ServerReloadPlugin from "@allurereport/plugin-server-reload";
import { PathResultFile } from "@allurereport/reader-api";
import { serve } from "@allurereport/static-server";
import { Command, Option } from "clipanion";
import * as console from "node:console";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

export class WatchCommand extends Command {
  static paths = [["watch"]];

  static usage = Command.Usage({
    description: "Watches Allure Results changes in Real-time",
    details: "This command watches for changes in the Allure Results directory and updates the report in real-time.",
    examples: [
      ["watch ./allure-results", "Watch for changes in the ./allure-results directory"],
      [
        "watch ./allure-results --port 8080",
        "Watch for changes in the ./allure-results directory and serve the report on port 8080",
      ],
    ],
  });

  resultsDir = Option.String({ required: true, name: "The directory with Allure results" });

  config = Option.String("--config,-c", {
    description: "The path Allure config file",
  });

  cwd = Option.String("--cwd", {
    description: "The working directory for the command to run (default: current working directory)",
  });

  output = Option.String("--output,-o", {
    description: "The output file name, allure.csv by default. Accepts absolute paths (default: ./allure-report)",
  });

  reportName = Option.String("--report-name,--name", {
    description: "The report name (default: Allure Report)",
  });

  port = Option.String("--port", {
    description: "The port to serve the reports on (default: random port)",
  });

  async execute() {
    const before = new Date().getTime();

    process.on("exit", (code) => {
      const after = new Date().getTime();

      console.log(`exit code ${code} (${after - before}ms)`);
    });

    const config = await readConfig(this.cwd, this.config, {
      output: this.output,
      name: this.reportName,
    });

    try {
      await rm(config.output, { recursive: true });
    } catch (e) {
      if (!isFileNotFoundError(e)) {
        console.error("could not clean output directory", e);
      }
    }

    const server = await serve({
      servePath: config.output,
      port: this.port ? parseInt(this.port, 10) : undefined,
      live: false,
      open: false,
    });

    const allureReport = new AllureReport({
      ...config,
      realTime: true,
      plugins: [
        ...(config.plugins?.length
          ? config.plugins
          : [
              {
                id: "awesome",
                enabled: true,
                options: {},
                plugin: new Awesome({
                  reportName: config.name,
                }),
              },
            ]),
        {
          id: "watch log",
          enabled: true,
          options: {},
          plugin: new ProgressPlugin(),
        },
        {
          id: "server reload",
          enabled: true,
          options: {},
          plugin: new ServerReloadPlugin({
            server,
          }),
        },
      ],
    });

    await allureReport.start();

    const input = resolve(this.resultsDir[0]);
    const { abort } = newFilesInDirectoryWatcher(input, async (path) => {
      await allureReport.readResult(new PathResultFile(path));
    });

    const pluginIdToOpen = config.plugins?.find((plugin) => !!plugin.options.open)?.id;
    if (pluginIdToOpen) {
      await server.open(join(server.url, pluginIdToOpen));
    } else {
      await server.open(server.url);
    }

    console.info("Press Ctrl+C to exit");

    process.on("SIGINT", async () => {
      // new line for ctrl+C character
      console.log("");
      await abort();
      await server.stop();
      await allureReport.done();
      process.exit(0);
    });
  }
}
