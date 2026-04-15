"use strict";

// ─── CSV parser ──────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let current = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        current.push(field);
        field = "";
        i++;
      } else if (ch === '\r') {
        i++;
      } else if (ch === '\n') {
        current.push(field);
        field = "";
        rows.push(current);
        current = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  // last field/row
  if (field || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  return rows;
}

// ─── XML escape ──────────────────────────────────────────────────────
function xmlEscape(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── OFX helpers ─────────────────────────────────────────────────────
function ofxDatetime(dt) {
  var pad = function(n) { return n < 10 ? "0" + n : "" + n; };
  return "" + dt.getFullYear() +
    pad(dt.getMonth() + 1) +
    pad(dt.getDate()) +
    pad(dt.getHours()) +
    pad(dt.getMinutes()) +
    pad(dt.getSeconds());
}

function stanza(tag) {
  var inner = Array.prototype.slice.call(arguments, 1);
  return "<" + tag + ">" + inner.join("\n") + "</" + tag + ">\n";
}

// ─── Core conversion logic (ported from Python) ─────────────────────
function convertFiles(fileTexts) {
  var transactions = "";
  var txnCount = 0;
  var first = null;
  var last = null;
  var venmoId = null;
  var defaultCurrency = null;
  var balance = null;
  var balanceTimestamp = null;
  var detectedFormat = null;
  var errors = [];

  function generate(tag, value) {
    if (typeof value === "string") {
      transactions += stanza(tag, xmlEscape(value));
    } else {
      transactions += tag;
    }
  }

  function parseRow(row, pos, isBiz) {
    var val = {};
    for (var k in pos) {
      if (Object.prototype.hasOwnProperty.call(pos, k)) {
        val[k] = (pos[k] < row.length) ? row[pos[k]] : "";
      }
    }

    // Skip non-transaction rows (empty second column)
    if (row[1] === "") {
      if (val["Ending Balance"]) {
        if (prevTimestamp && (!balanceTimestamp || prevTimestamp >= balanceTimestamp)) {
          balance = val["Ending Balance"];
          balanceTimestamp = prevTimestamp;
        }
      }
      return;
    }

    // Start transaction
    generate("<STMTTRN>");

    if (val["Amount (total)"].startsWith("-")) {
      generate("TRNTYPE", "DEBIT");
    } else {
      generate("TRNTYPE", "CREDIT");
    }

    var timestamp, id, amount;
    if (isBiz) {
      var dtStr = val["Date"] + " " + val["Time (UTC)"];
      var parts = dtStr.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
      if (!parts) {
        throw new Error("Cannot parse business date: " + dtStr);
      }
      timestamp = new Date(
        parseInt(parts[3]), parseInt(parts[1]) - 1, parseInt(parts[2]),
        parseInt(parts[4]), parseInt(parts[5]), parseInt(parts[6])
      );
      id = val["Transaction ID"].replace(/"/g, "");
      amount = val["Amount (net)"];
      if (amount === "0" || amount === "") {
        amount = val["Amount (total)"];
      }
    } else {
      timestamp = new Date(val["Datetime"]);
      if (isNaN(timestamp.getTime())) {
        throw new Error("Cannot parse consumer date: " + val["Datetime"]);
      }
      id = val["ID"];
      amount = val["Amount (total)"];
    }

    prevTimestamp = timestamp;

    if (!first || timestamp < first) first = timestamp;
    if (!last || timestamp > last) last = timestamp;

    generate("DTPOSTED", ofxDatetime(timestamp));

    // Currency handling
    var currency = null;
    if (amount.indexOf("$") !== -1) {
      if (!defaultCurrency) {
        defaultCurrency = "USD";
      } else if (defaultCurrency !== "USD") {
        currency = stanza("CURRENCY",
          stanza("CURRATE", "1.0"),
          stanza("CURSYM", "USD"));
      }
    } else {
      throw new Error("Unsupported currency in amount: " + amount);
    }

    amount = amount.replace(/,/g, "").replace(/\$/g, "").replace(/\s/g, "").replace(/\+/g, "");
    generate("TRNAMT", amount);
    generate("FITID", id);

    // Determine other party
    var otherParty = val["To"];
    var transferTo = null;

    if (val["Type"] === "Standard Transfer" && val["From"] === "(None)") {
      otherParty = "VENMO-CASHOUT to " + val["Destination"];
      transferTo = stanza("BANKACCTTO",
        stanza("BANKID", val["Destination"]),
        stanza("ACCTID", val["Destination"]),
        stanza("ACCTTYPE", "CHECKING"));
    } else if (val["Type"] === "Payment") {
      if (!val["Amount (total)"].startsWith("-")) {
        otherParty = val["From"];
      }
    } else if (val["Type"] === "Charge") {
      if (val["Amount (total)"].startsWith("-")) {
        otherParty = val["From"];
      }
    }

    generate("NAME", otherParty);

    if (val["Note"] !== "(None)") {
      generate("MEMO", val["Note"]);
    }

    if (transferTo) {
      generate(transferTo);
    }

    if (currency) {
      generate(currency);
    }

    generate("</STMTTRN>\n");
    txnCount++;

    // Handle funding source / destination for secondary transactions
    var dest = val["Destination"].replace("Venmo balance", "").replace("(None)", "");
    var src = val["Funding Source"].replace("Venmo balance", "").replace("(None)", "");
    var account = null;

    if (dest && !src) {
      account = dest;
    } else if (src && !dest) {
      account = src;
    } else if (src && dest) {
      errors.push("Did not expect source (" + src + ") and destination (" + dest + ") accounts");
    }

    if (account && val["Type"] !== "Standard Transfer") {
      // Emit a second transaction for bank debit/credit
      var secondaryAmount;
      if (amount.startsWith("-")) {
        secondaryAmount = amount.replace("-", "");
      } else {
        secondaryAmount = "-" + amount;
      }

      generate(stanza("STMTTRN",
        stanza("TRNTYPE", "CREDIT"),
        stanza("DTPOSTED", ofxDatetime(timestamp)),
        stanza("TRNAMT", secondaryAmount),
        stanza("FITID", id + ".1"),
        stanza("NAME", "VENMO PAYMENT from " + account),
        stanza("BANKACCTTO",
          stanza("BANKID", account),
          stanza("ACCTID", account),
          stanza("ACCTTYPE", "CHECKING")),
        currency || ""
      ));
      txnCount++;
    }
  }

  // Process each file
  var prevTimestamp = null;

  for (var fi = 0; fi < fileTexts.length; fi++) {
    var text = fileTexts[fi].text;
    var fileName = fileTexts[fi].name;
    var rows = parseCSV(text);
    var pos = {};
    var isBiz = false;
    prevTimestamp = null;

    for (var ri = 0; ri < rows.length; ri++) {
      var row = rows[ri];
      if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;
      // Skip fully blank rows (e.g., separator lines in some CSV exports)
      if (row.every(function(c) { return c === ""; })) continue;

      // Account Statement header
      if (row[0].startsWith("Account Statement - (@")) {
        var newId = row[0].split("(")[1].split(")")[0];
        if (venmoId && venmoId !== newId) {
          throw new Error(
            "Cannot mix Venmo IDs " + venmoId + " and " + newId + "; exclude file '" + fileName + "'"
          );
        }
        venmoId = newId;
        continue;
      }

      // Account Activity header
      if (row[0] === "Account Activity") {
        continue;
      }

      // Column headers row
      if (!Object.keys(pos).length) {
        for (var ci = 0; ci < row.length; ci++) {
          pos[row[ci]] = ci;
        }
        isBiz = "Amount (net)" in pos;
        detectedFormat = isBiz ? "Business" : "Consumer";
        continue;
      }

      // Data row
      try {
        parseRow(row, pos, isBiz);
      } catch (e) {
        throw new Error("Error parsing row " + (ri + 1) + " in " + fileName + ": " + e.message);
      }
    }

  }

  if (!transactions) {
    throw new Error("No transactions found in the provided file(s).");
  }

  // Build full OFX document
  var ofxHeader = '<?xml version="1.0" encoding="utf-8" ?>\n' +
    '<?OFX OFXHEADER="200" VERSION="202" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>\n';

  var ofxBody = stanza("OFX",
    stanza("BANKMSGSRSV1",
      stanza("STMTTRNRS",
        stanza("TRNUID", "1001"),
        stanza("STATUS",
          stanza("CODE", "0"),
          stanza("SEVERITY", "INFO")),
        stanza("STMTRS",
          stanza("CURDEF", defaultCurrency),
          stanza("BANKACCTFROM",
            stanza("BANKID", "Venmo"),
            stanza("ACCTID", venmoId),
            stanza("ACCTTYPE", "CHECKING")),
          stanza("BANKTRANLIST",
            stanza("DTSTART", ofxDatetime(first)),
            stanza("DTEND", ofxDatetime(last)),
            transactions.replace(/\n\n/g, "\n")),
          stanza("LEDGERBAL",
            stanza("BALAMT", balance || "0.00"),
            stanza("DTASOF", ofxDatetime(balanceTimestamp || last)))
        ))));

  return {
    ofxText: ofxHeader + ofxBody,
    venmoId: venmoId,
    format: detectedFormat,
    txnCount: txnCount,
    first: first,
    last: last,
    balance: balance,
    errors: errors
  };
}

// ─── Export for Node.js (tests) / no-op in browser ───────────────────
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseCSV: parseCSV, xmlEscape: xmlEscape, ofxDatetime: ofxDatetime, stanza: stanza, convertFiles: convertFiles };
}
