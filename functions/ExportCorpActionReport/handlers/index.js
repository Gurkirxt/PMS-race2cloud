"use strict";

/**
 * Registry of corporate-action impact report handlers, keyed by reportType.
 *
 * Each handler implements the same contract (see split.js):
 *   { reportType, header, buildManifest(zcql, from, to), buildEventCsv({...}) }
 *
 * To add a new report type (bonus / dividend / merger / demerger): create
 * handlers/<type>.js implementing that contract and register it here. The
 * generic driver (../index.js) needs no changes.
 */

const split = require("./split.js");
const bonus = require("./bonus.js");
const dividend = require("./dividend.js");
const merger = require("./merger.js");
const demerger = require("./demerger.js");

const HANDLERS = {
  [split.reportType]: split,
  [bonus.reportType]: bonus,
  [dividend.reportType]: dividend,
  [merger.reportType]: merger,
  [demerger.reportType]: demerger,
};

function getHandler(reportType) {
  return HANDLERS[String(reportType || "").toLowerCase()] || null;
}

module.exports = { getHandler, HANDLERS };
