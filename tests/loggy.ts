import { NSLog } from "../src/Foundation";
import { NSStringFromString } from "../src/helpers";

console.log("Creating NSString");
const intro = NSStringFromString("Hello, world!");
console.log("Running NSLog");
NSLog(intro);
console.log("Done");
