/* Static contract for the legal Books shelf and reader bootstrap. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const app = read("assets/app.js");
const html = read("index.html");
const route = read("assets/routes/books.js");

const shelfStart = app.indexOf("const freeChessBooks = Object.freeze([");
const shelfEnd = app.indexOf("const bookReaderStorageKey", shelfStart);
assert.ok(shelfStart >= 0 && shelfEnd > shelfStart, "Books shelf data must be declared in the application runtime.");
const shelf = app.slice(shelfStart, shelfEnd);
assert.equal((shelf.match(/\bid:\s*"[^"]+"/g) || []).length, 9, "Books shelf must restore the nine verified records advertised by the page.");
assert.equal((shelf.match(/sourceUrl:\s*"https:\/\/www\.gutenberg\.org\/ebooks\/\d+"/g) || []).length, 9, "Every restored book must use a direct Project Gutenberg source link.");
assert.match(app, /function getAllBooks\(\)\s*\{\s*return \[\.\.\.freeChessBooks, \.\.\.readCustomBooks\(\)\];/, "Books rendering must combine verified books with local admin records.");
assert.match(app, /function setupBooks\(\)[\s\S]*?renderBooks\(\);/, "Books route must render its shelf during deferred setup.");
assert.match(route, /export const features = Object\.freeze\(\["books"\]\)/, "Books route manifest must request the Books feature.");
assert.match(html, /id="bookSearch"/);
assert.match(html, /id="bookGrid"/);
assert.match(html, /id="continueReadingBook"/);
assert.match(html, /verified free books/);

console.log("PASS Books regression: verified shelf data, route manifest, grid, filters, and reader entry points are present.");
