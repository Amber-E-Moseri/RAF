import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readSettings = () => readFile(new URL("../src/pages/Settings.tsx", import.meta.url), "utf8");
const readApp = () => readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const readAppLayout = () => readFile(new URL("../src/components/layout/AppLayout.tsx", import.meta.url), "utf8");

test("Settings.tsx exists and exports Settings component", async () => {
  const source = await readSettings();
  assert.match(source, /export function Settings/, "Settings.tsx must export a Settings function component");
});

test("Settings uses useSearchParams for URL-based tab routing", async () => {
  const source = await readSettings();
  assert.match(source, /useSearchParams/, "Settings must use useSearchParams for tab routing");
  assert.match(source, /searchParams\.get\("tab"\)/, "Settings must read tab from URL search params");
});

test("Settings has all five required tabs", async () => {
  const source = await readSettings();
  assert.match(source, /profile/, "Settings must include profile tab");
  assert.match(source, /household/, "Settings must include household tab");
  assert.match(source, /appearance/, "Settings must include appearance tab");
  assert.match(source, /financial/, "Settings must include financial tab");
  assert.match(source, /import_rules/, "Settings must include import_rules tab");
});

test("Settings falls back to profile tab for invalid tab values", async () => {
  const source = await readSettings();
  assert.match(source, /VALID_TABS/, "Settings must validate tab value against allowed list");
  assert.match(source, /"profile".*DEFAULT_TAB|DEFAULT_TAB.*"profile"|: "profile"/, "Settings must default to profile tab");
});

test("App.tsx routes /settings to the new Settings component", async () => {
  const source = await readApp();
  assert.match(source, /import.*Settings.*from.*pages\/Settings/, "App.tsx must import Settings from pages/Settings");
  assert.match(source, /<Settings\s*\/>/, "App.tsx must render Settings component at /settings route");
});

test("App.tsx does not import old AppearanceSettings, Profile, or Members pages as route components", async () => {
  const source = await readApp();
  assert.doesNotMatch(source, /import.*AppearanceSettings.*from/, "App.tsx must not import AppearanceSettings as a standalone route");
  assert.doesNotMatch(source, /import.*Profile.*from.*pages\/Profile/, "App.tsx must not import Profile as a standalone route");
  assert.doesNotMatch(source, /import.*Members.*from.*pages\/Members/, "App.tsx must not import Members as a standalone route");
});

test("/profile redirects to /settings?tab=profile", async () => {
  const source = await readApp();
  assert.match(source, /path.*profile.*Navigate.*settings.*tab=profile|Navigate.*settings.*tab=profile.*profile/,
    "/profile route must redirect to /settings?tab=profile");
});

test("/members redirects to /settings?tab=household", async () => {
  const source = await readApp();
  assert.match(source, /path.*members.*Navigate.*settings.*tab=household|Navigate.*settings.*tab=household.*members/,
    "/members route must redirect to /settings?tab=household");
});

test("AppLayout removes standalone Household/Stewards nav group", async () => {
  const source = await readAppLayout();
  assert.doesNotMatch(source, /label:\s*"Household"/, "Household nav group must be removed from AppLayout desktop nav");
  assert.doesNotMatch(source, /to:\s*"\/members"/, "Direct /members nav link must be removed from AppLayout desktop nav");
});

test("AppLayout Profile link points to /settings?tab=profile", async () => {
  const source = await readAppLayout();
  assert.match(source, /settings\?tab=profile/, "Profile link in AppLayout sidebar must point to /settings?tab=profile");
});
