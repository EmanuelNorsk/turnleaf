import { describe, expect, it } from "vitest";
import { scrub } from "./scrub.js";

describe("scrub", () => {
  it("removes UUIDs", () => {
    expect(scrub("UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5")).toBe(
      "UUID of player [player] is [uuid]",
    );
  });

  it("removes public IPs but keeps loopback", () => {
    expect(scrub("connected from 203.0.113.42:51234")).toBe("connected from [ip]");
    expect(scrub("listening on 127.0.0.1:25565")).toContain("127.0.0.1");
  });

  it("removes usernames from home paths", () => {
    expect(scrub("at C:\\Users\\eem50\\server\\plugins\\X.jar")).toBe("at C:\\Users\\[user]\\server\\plugins\\X.jar");
    expect(scrub("/home/emanuel/server/logs/latest.log")).toBe("/home/[user]/server/logs/latest.log");
    expect(scrub("/Users/emanuel/server")).toBe("/Users/[user]/server");
  });

  it("removes player names from join/leave/connect lines", () => {
    expect(scrub("[12:00:00 INFO]: Steve joined the game")).toBe("[12:00:00 INFO]: [player] joined the game");
    expect(scrub("[12:00:00 INFO]: Steve left the game")).toBe("[12:00:00 INFO]: [player] left the game");
    expect(scrub("[12:00:01 INFO]: Steve[/203.0.113.42:51234] logged in")).toBe(
      "[12:00:01 INFO]: [player][/[ip]] logged in",
    );
  });

  it("leaves stack traces alone", () => {
    const trace = "\tat com.example.Foo.bar(Foo.java:42)";
    expect(scrub(trace)).toBe(trace);
  });
});
