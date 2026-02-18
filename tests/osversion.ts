import { NSProcessInfo } from "../src/Foundation";

function getOperatingSystemVersion() {
  const version = NSProcessInfo.processInfo().operatingSystemVersion();
  return {
    major: version.field0,
    minor: version.field1,
    patch: version.field2,
  };
}

console.log(getOperatingSystemVersion());
