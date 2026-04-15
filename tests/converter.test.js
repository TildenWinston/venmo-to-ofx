import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { parseCSV, xmlEscape, ofxDatetime, stanza, convertFiles } from "../converter.js";

// ─── Helpers ─────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadFixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf-8");
}

function fileInput(name) {
  return { name: name, text: loadFixture(name) };
}

// ─── parseCSV ────────────────────────────────────────────────────────
describe("parseCSV", () => {
  it("parses basic comma-separated rows", () => {
    const result = parseCSV("a,b,c\n1,2,3\n");
    expect(result).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with commas", () => {
    const result = parseCSV('name,"city, state",zip\n');
    expect(result).toEqual([["name", "city, state", "zip"]]);
  });

  it("handles embedded double-quotes inside quoted fields", () => {
    const result = parseCSV('say,"He said ""hi""",end\n');
    expect(result).toEqual([["say", 'He said "hi"', "end"]]);
  });

  it("strips \\r (CRLF line endings)", () => {
    const result = parseCSV("a,b\r\nc,d\r\n");
    expect(result).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("handles trailing content without final newline", () => {
    const result = parseCSV("x,y");
    expect(result).toEqual([["x", "y"]]);
  });

  it("returns rows for empty lines", () => {
    const result = parseCSV("a\n\nb\n");
    expect(result).toEqual([["a"], [""], ["b"]]);
  });
});

// ─── xmlEscape ───────────────────────────────────────────────────────
describe("xmlEscape", () => {
  it("escapes ampersands", () => {
    expect(xmlEscape("A & B")).toBe("A &amp; B");
  });

  it("escapes angle brackets", () => {
    expect(xmlEscape("<tag>")).toBe("&lt;tag&gt;");
  });

  it("escapes double and single quotes", () => {
    expect(xmlEscape('"hello\'')).toBe("&quot;hello&apos;");
  });

  it("handles strings with no special characters", () => {
    expect(xmlEscape("plain text")).toBe("plain text");
  });

  it("handles all special characters together", () => {
    expect(xmlEscape(`<"Tom & Jerry's">"`)).toBe(
      "&lt;&quot;Tom &amp; Jerry&apos;s&quot;&gt;&quot;"
    );
  });
});

// ─── ofxDatetime ─────────────────────────────────────────────────────
describe("ofxDatetime", () => {
  it("formats a date with zero-padded fields", () => {
    const dt = new Date(2024, 0, 5, 3, 7, 9); // Jan 5, 2024 03:07:09
    expect(ofxDatetime(dt)).toBe("20240105030709");
  });

  it("formats a date with double-digit fields", () => {
    const dt = new Date(2024, 11, 25, 14, 30, 59); // Dec 25, 2024 14:30:59
    expect(ofxDatetime(dt)).toBe("20241225143059");
  });
});

// ─── stanza ──────────────────────────────────────────────────────────
describe("stanza", () => {
  it("wraps content in XML tags", () => {
    expect(stanza("TAG", "value")).toBe("<TAG>value</TAG>\n");
  });

  it("joins multiple inner arguments with newline", () => {
    expect(stanza("OUTER", "a", "b")).toBe("<OUTER>a\nb</OUTER>\n");
  });

  it("handles nested stanzas", () => {
    const result = stanza("OUTER", stanza("INNER", "val"));
    expect(result).toBe("<OUTER><INNER>val</INNER>\n</OUTER>\n");
  });
});

// ─── convertFiles — Consumer format ──────────────────────────────────
describe("convertFiles — Consumer CSV", () => {
  let result;

  // Run conversion once for the fixture
  it("converts without throwing", () => {
    result = convertFiles([fileInput("consumer.csv")]);
    expect(result).toBeDefined();
  });

  it("detects Consumer format", () => {
    expect(result.format).toBe("Consumer");
  });

  it("extracts the Venmo account ID", () => {
    expect(result.venmoId).toBe("@testuser");
  });

  it("produces the correct primary transaction count", () => {
    // 5 primary + 1 secondary (for external funding source on t103)
    expect(result.txnCount).toBe(6);
  });

  it("computes the correct date range", () => {
    expect(result.first.getFullYear()).toBe(2024);
    expect(result.first.getMonth()).toBe(2); // March = 2
    expect(result.first.getDate()).toBe(15);

    expect(result.last.getMonth()).toBe(2);
    expect(result.last.getDate()).toBe(28);
  });

  it("captures the ending balance", () => {
    expect(result.balance).toBe("$817.50");
  });

  it("produces valid OFX header", () => {
    expect(result.ofxText).toContain('<?xml version="1.0" encoding="utf-8" ?>');
    expect(result.ofxText).toContain('<?OFX OFXHEADER="200"');
  });

  it("includes BANKACCTFROM with Venmo and account ID", () => {
    expect(result.ofxText).toContain("<BANKID>Venmo</BANKID>");
    expect(result.ofxText).toContain("<ACCTID>@testuser</ACCTID>");
  });

  it("marks debit transactions as DEBIT", () => {
    // t100 is "- $25.00"
    const t100Pos = result.ofxText.indexOf("<FITID>t100</FITID>");
    expect(t100Pos).toBeGreaterThan(-1);
    // Find the TRNTYPE before this FITID
    const chunk = result.ofxText.substring(t100Pos - 300, t100Pos);
    expect(chunk).toContain("<TRNTYPE>DEBIT</TRNTYPE>");
  });

  it("marks credit transactions as CREDIT", () => {
    // t101 is "+ $500.00"
    const t101Pos = result.ofxText.indexOf("<FITID>t101</FITID>");
    const chunk = result.ofxText.substring(t101Pos - 300, t101Pos);
    expect(chunk).toContain("<TRNTYPE>CREDIT</TRNTYPE>");
  });

  it("formats amounts without $ or + signs", () => {
    expect(result.ofxText).toContain("<TRNAMT>-25.00</TRNAMT>");
    expect(result.ofxText).toContain("<TRNAMT>500.00</TRNAMT>");
  });

  it("sets NAME to the correct other party for payments", () => {
    // t101: incoming payment → From = "Charlie Brown"
    expect(result.ofxText).toContain("<NAME>Charlie Brown</NAME>");
    // t100: outgoing payment → To = "Bob Jones"
    expect(result.ofxText).toContain("<NAME>Bob Jones</NAME>");
  });

  it("includes MEMO for transactions with notes", () => {
    expect(result.ofxText).toMatch(/<MEMO>Lunch 🍕<\/MEMO>/);
    expect(result.ofxText).toContain("<MEMO>Groceries &amp; stuff</MEMO>");
  });

  it("omits MEMO when note is (None)", () => {
    // Standard Transfer t102 has note "(None)" — should NOT produce a MEMO
    const t102Pos = result.ofxText.indexOf("<FITID>t102</FITID>");
    const nextStmt = result.ofxText.indexOf("</STMTTRN>", t102Pos);
    const t102Block = result.ofxText.substring(t102Pos, nextStmt);
    expect(t102Block).not.toContain("<MEMO>");
  });

  it("generates BANKACCTTO for Standard Transfer", () => {
    const t102Pos = result.ofxText.indexOf("<FITID>t102</FITID>");
    const nextStmt = result.ofxText.indexOf("</STMTTRN>", t102Pos);
    const t102Block = result.ofxText.substring(t102Pos, nextStmt);
    expect(t102Block).toContain("<BANKACCTTO>");
    expect(t102Block).toContain("Chase Checking ****1234");
  });

  it("generates NAME with VENMO-CASHOUT for Standard Transfer", () => {
    expect(result.ofxText).toContain("<NAME>VENMO-CASHOUT to Chase Checking ****1234</NAME>");
  });

  it("generates secondary bank-debit transaction for external funding", () => {
    // t103 uses "Wells Fargo Debit ****5678" funding source → secondary txn with FITID t103.1
    expect(result.ofxText).toContain("<FITID>t103.1</FITID>");
    expect(result.ofxText).toContain("<NAME>VENMO PAYMENT from Wells Fargo Debit ****5678</NAME>");
  });

  it("secondary transaction has inverted amount", () => {
    // t103 primary is -42.50, secondary should be 42.50
    const secPos = result.ofxText.indexOf("<FITID>t103.1</FITID>");
    const chunk = result.ofxText.substring(secPos - 300, secPos);
    expect(chunk).toContain("<TRNAMT>42.50</TRNAMT>");
  });

  it("sets Charge debit NAME to From", () => {
    // t104: Charge with negative amount → otherParty = From = "Eve Adams"
    expect(result.ofxText).toContain("<NAME>Eve Adams</NAME>");
  });

  it("sets CURDEF to USD", () => {
    expect(result.ofxText).toContain("<CURDEF>USD</CURDEF>");
  });

  it("has no conversion errors/warnings", () => {
    expect(result.errors).toEqual([]);
  });
});

// ─── convertFiles — Business format ──────────────────────────────────
describe("convertFiles — Business CSV", () => {
  let result;

  it("converts without throwing", () => {
    result = convertFiles([fileInput("business.csv")]);
    expect(result).toBeDefined();
  });

  it("detects Business format", () => {
    expect(result.format).toBe("Business");
  });

  it("extracts the Venmo account ID", () => {
    expect(result.venmoId).toBe("@bizuser");
  });

  it("uses Amount (net) when available", () => {
    // b200: net = $1,165.00 → amount should be 1165.00
    expect(result.ofxText).toContain("<TRNAMT>1165.00</TRNAMT>");
  });

  it("falls back to Amount (total) when net is 0", () => {
    // b201: net = 0, total = "- $300.00" → amount should be -300.00
    expect(result.ofxText).toContain("<TRNAMT>-300.00</TRNAMT>");
  });

  it("parses business date format correctly", () => {
    // b200: 03/10/2024 08:30:00 → 20240310083000
    expect(result.ofxText).toContain("<DTPOSTED>20240310083000</DTPOSTED>");
  });

  it("captures the ending balance", () => {
    expect(result.balance).toBe("$865.00");
  });

  it("produces correct transaction count", () => {
    expect(result.txnCount).toBe(2);
  });
});

// ─── convertFiles — Multi-file / error cases ─────────────────────────
describe("convertFiles — Multi-file & error cases", () => {
  it("throws when mixing different Venmo account IDs", () => {
    expect(() => {
      convertFiles([
        fileInput("consumer.csv"),
        fileInput("consumer-different-account.csv"),
      ]);
    }).toThrow(/Cannot mix Venmo IDs/);
  });

  it("throws when no transactions are found", () => {
    const emptyCSV =
      '"Account Statement - (@empty) (Jan 1, 2024 - Jan 31, 2024)"\n' +
      ",\n" +
      "Account Activity\n" +
      ",\n" +
      "ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer\n" +
      ",,,,,,,,,,,,,,,,$0.00,,,$0.00,\n";
    expect(() => {
      convertFiles([{ name: "empty.csv", text: emptyCSV }]);
    }).toThrow(/No transactions found/);
  });

  it("throws for unsupported currency", () => {
    const badCSV =
      '"Account Statement - (@user1) (Jan 1, 2024 - Jan 31, 2024)"\n' +
      ",\n" +
      "Account Activity\n" +
      ",\n" +
      "ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (tip),Amount (tax),Tax Rate,Tax Exempt,Funding Source,Destination,Beginning Balance,Ending Balance,Statement Period Venmo Fees,Terminal Location,Year to Date Venmo Fees,Disclaimer\n" +
      "t1,2024-01-10T12:00:00,Payment,Complete,Test,A,B,€50.00,,,,,,Venmo balance,(None),,,,,,\n";
    expect(() => {
      convertFiles([{ name: "bad.csv", text: badCSV }]);
    }).toThrow(/Unsupported currency/);
  });
});
