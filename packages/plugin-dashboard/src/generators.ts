import type { HistoryDataPoint, Statistic, TestResult } from "@allurereport/core-api";
import type { AllureStore, PluginContext, ReportFiles } from "@allurereport/plugin-api";
import {
  DEFAULT_CHART_HISTORY_LIMIT,
  createBaseUrlScript,
  createFontLinkTag,
  createReportDataScript,
  createScriptTag,
  createStylesLinkTag,
} from "@allurereport/web-commons";
import type { DashboardReportOptions } from "@allurereport/web-dashboard";
import { randomUUID } from "crypto";
import Handlebars from "handlebars";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { getSeverityTrendData } from "./charts/severityTrend.js";
import { getPieChartData } from "./charts/statusPie.js";
import { getStatusTrendData } from "./charts/statusTrend.js";
import type {
  DashboardOptions,
  DashboardPluginOptions,
  GeneratedChartData,
  GeneratedChartsData,
  PieChartData,
  PieChartOptions,
  TemplateManifest,
  TrendChartData,
  TrendChartOptions,
} from "./model.js";
import { ChartData, ChartType } from "./model.js";
import type { DashboardDataWriter, ReportFile } from "./writer.js";

const require = createRequire(import.meta.url);

const template = `<!DOCTYPE html>
<html dir="ltr" lang="en">
<head>
    <meta charset="utf-8">
    <title> {{ reportName }} </title>
    <link rel="icon" href="favicon.ico">
    {{{ headTags }}}
</head>
<body>
    <div id="app"></div>
    ${createBaseUrlScript()}
    <script>
      window.allure = window.allure || {};
    </script>
    {{{ bodyTags }}}
    {{#if analyticsEnable}}
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-LNDJ3J7WT0"></script>
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', 'G-LNDJ3J7WT0', {
          "report": "dashboard",
          "allureVersion": "{{ allureVersion }}",
          "reportUuid": "{{ reportUuid }}",
          "single_file": "{{singleFile}}"
        });
    </script>
    {{/if}}
    <script>
      window.allureReportOptions = {{{ reportOptions }}}
    </script>
    {{{ reportFilesScript }}}
</body>
</html>
`;

export const readTemplateManifest = async (singleFileMode?: boolean): Promise<TemplateManifest> => {
  const templateManifestSource = require.resolve(
    `@allurereport/web-dashboard/dist/${singleFileMode ? "single" : "multi"}/manifest.json`,
  );
  const templateManifest = await readFile(templateManifestSource, { encoding: "utf-8" });

  return JSON.parse(templateManifest);
};

const generateTrendChart = (
  options: TrendChartOptions,
  stores: {
    historyDataPoints: HistoryDataPoint[];
    statistic: Statistic;
    testResults: TestResult[];
  },
  context: PluginContext,
): TrendChartData | undefined => {
  const newOptions = { limit: DEFAULT_CHART_HISTORY_LIMIT, ...options };
  const { dataType } = newOptions;
  const { statistic, historyDataPoints, testResults } = stores;

  if (dataType === ChartData.Status) {
    return getStatusTrendData(statistic, context.reportName, historyDataPoints, newOptions);
  } else if (dataType === ChartData.Severity) {
    return getSeverityTrendData(testResults, context.reportName, historyDataPoints, newOptions);
  }
};

const generatePieChart = (
  options: PieChartOptions,
  stores: {
    statistic: Statistic;
  },
): PieChartData => {
  const { statistic } = stores;

  return getPieChartData(statistic, options);
};

export const generateCharts = async (
  options: DashboardPluginOptions,
  store: AllureStore,
  context: PluginContext,
): Promise<GeneratedChartsData | undefined> => {
  const { layout } = options;

  if (!layout) {
    return undefined;
  }

  const historyDataPoints = await store.allHistoryDataPoints();
  const statistic = await store.testsStatistic();
  const testResults = await store.allTestResults();

  return layout.reduce((acc, chartOptions) => {
    const chartId = randomUUID();

    let chart: GeneratedChartData | undefined;

    if (chartOptions.type === ChartType.Trend) {
      chart = generateTrendChart(
        chartOptions,
        {
          historyDataPoints,
          statistic,
          testResults,
        },
        context,
      );
    } else if (chartOptions.type === ChartType.Pie) {
      chart = generatePieChart(chartOptions, { statistic });
    }

    if (chart) {
      acc[chartId] = chart;
    }

    return acc;
  }, {} as GeneratedChartsData);
};

export const generateAllCharts = async (
  writer: DashboardDataWriter,
  store: AllureStore,
  options: DashboardPluginOptions,
  context: PluginContext,
): Promise<void> => {
  const charts = await generateCharts(options, store, context);

  if (charts && Object.keys(charts).length > 0) {
    await writer.writeWidget("charts.json", charts);
  }
};

export const generateStaticFiles = async (
  payload: DashboardOptions & {
    allureVersion: string;
    reportFiles: ReportFiles;
    reportDataFiles: ReportFile[];
    reportUuid: string;
    reportName: string;
  },
) => {
  const {
    reportName = "Allure Report",
    reportLanguage = "en",
    singleFile,
    logo = "",
    theme = "light",
    reportFiles,
    reportDataFiles,
    reportUuid,
    allureVersion,
  } = payload;
  const compile = Handlebars.compile(template);
  const manifest = await readTemplateManifest(payload.singleFile);
  const headTags: string[] = [];
  const bodyTags: string[] = [];

  if (!payload.singleFile) {
    for (const key in manifest) {
      const fileName = manifest[key];
      const filePath = require.resolve(
        join("@allurereport/web-dashboard/dist", singleFile ? "single" : "multi", fileName),
      );

      if (key.includes(".woff")) {
        headTags.push(createFontLinkTag(fileName));
      }

      if (key === "main.css") {
        headTags.push(createStylesLinkTag(fileName));
      }
      if (key === "main.js") {
        bodyTags.push(createScriptTag(fileName));
      }

      // we don't need to handle another files in single file mode
      if (singleFile) {
        continue;
      }

      const fileContent = await readFile(filePath);

      await reportFiles.addFile(basename(filePath), fileContent);
    }
  } else {
    const mainJs = manifest["main.js"];
    const mainJsSource = require.resolve(`@allurereport/web-dashboard/dist/single/${mainJs}`);
    const mainJsContentBuffer = await readFile(mainJsSource);

    bodyTags.push(createScriptTag(`data:text/javascript;base64,${mainJsContentBuffer.toString("base64")}`));
  }

  const reportOptions: DashboardReportOptions = {
    reportName,
    logo,
    theme,
    reportLanguage,
    createdAt: Date.now(),
    reportUuid,
    allureVersion,
  };

  const html = compile({
    headTags: headTags.join("\n"),
    bodyTags: bodyTags.join("\n"),
    reportFilesScript: createReportDataScript(reportDataFiles),
    reportOptions: JSON.stringify(reportOptions),
    analyticsEnable: true,
    allureVersion,
    reportUuid,
    reportName,
    singleFile: payload.singleFile,
  });

  await reportFiles.addFile("index.html", Buffer.from(html, "utf8"));
};
