import {
  ASAuthorizationPlatformPublicKeyCredentialProvider,
  ASAuthorizationPlatformPublicKeyCredentialRegistrationRequestStyle,
} from "../src/AuthenticationServices";
import { NSData, NSString } from "../src/Foundation";

const rpId = NSString.stringWithUTF8String$("com.example.app");
if (!rpId) throw new Error("Failed to create rpId");
const platformProvider =
  ASAuthorizationPlatformPublicKeyCredentialProvider.alloc().initWithRelyingPartyIdentifier$(
    rpId
  );
if (!platformProvider) throw new Error("Failed to create platform provider");
const challengeBuffer = Buffer.from("challenge", "utf-8");
const challenge = NSData.dataWithBytes$length$(
  challengeBuffer,
  challengeBuffer.length
);
if (!challenge) throw new Error("Failed to create challenge");

const name = NSString.stringWithUTF8String$("John Doe");
if (!name) throw new Error("Failed to create name");

const userIDBuf = Buffer.from("1234567890", "utf-8");
const userID = NSData.dataWithBytes$length$(userIDBuf, userIDBuf.length);
if (!userID) throw new Error("Failed to create userID");

const platformKeyRequest =
  platformProvider.createCredentialRegistrationRequestWithChallenge$name$userID$(
    challenge,
    name,
    userID
  );

console.log("platformKeyRequest", platformKeyRequest);

platformKeyRequest.setRequestStyle$(
  ASAuthorizationPlatformPublicKeyCredentialRegistrationRequestStyle.Conditional
);
