// ============================
// AUTH SERVICE (Cognito)
// ============================
require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const crypto = require("crypto");
const QRCode = require("qrcode");
const {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  SetUserMFAPreferenceCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

const region = "ap-southeast-2";
const cognito = new CognitoIdentityProviderClient({ region });

function hashSecret(username) {
  return crypto
    .createHmac("SHA256", process.env.COGNITO_CLIENT_SECRET)
    .update(username + process.env.COGNITO_CLIENT_ID)
    .digest("base64");
}

const app = express();
app.use(cors());
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Signup
app.post("/auth/signup", async (req, res) => {
  const { username, password, email, fullName } = req.body;
  try {
    const cmd = new SignUpCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: username,
      Password: password,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "name", Value: fullName || username }
      ],
      SecretHash: hashSecret(username),
    });
    await cognito.send(cmd);
    res.json({ message: "Signup successful, check your email for the confirmation code" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Confirm signup
app.post("/auth/confirm", async (req, res) => {
  const { username, code } = req.body;
  try {
    const cmd = new ConfirmSignUpCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: username,
      ConfirmationCode: code,
      SecretHash: hashSecret(username),
    });
    await cognito.send(cmd);
    res.json({ message: "User confirmed successfully" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Login
app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const cmd = new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: process.env.COGNITO_CLIENT_ID,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password,
        SECRET_HASH: hashSecret(username),
      },
    });
    const out = await cognito.send(cmd);
    if (out.ChallengeName === "SMS_MFA" || out.ChallengeName === "SOFTWARE_TOKEN_MFA") {
      return res.json({ challenge: out.ChallengeName, session: out.Session });
    }
    res.json({
      idToken: out.AuthenticationResult.IdToken,
      accessToken: out.AuthenticationResult.AccessToken,
    });
  } catch (err) {
    res.status(401).json({ error: "Login failed: " + err.message });
  }
});

// Setup TOTP
app.post("/auth/setup-totp", async (req, res) => {
  const { accessToken, username } = req.body;
  try {
    const cmd = new AssociateSoftwareTokenCommand({ AccessToken: accessToken });
    const out = await cognito.send(cmd);
    const secret = out.SecretCode;
    const issuer = "PDFConverter";
    const uri = `otpauth://totp/${issuer}:${username}?secret=${secret}&issuer=${issuer}`;
    const qrCodeDataURL = await QRCode.toDataURL(uri);
    res.json({ secret, uri, qrCode: qrCodeDataURL });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Verify TOTP
app.post("/auth/verify-totp", async (req, res) => {
  const { accessToken, code } = req.body;
  try {
    const cmd = new VerifySoftwareTokenCommand({ AccessToken: accessToken, UserCode: code });
    const out = await cognito.send(cmd);
    res.json({ status: out.Status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Respond to MFA challenge (software token)
app.post("/auth/mfa", async (req, res) => {
  const { username, session, code } = req.body;
  try {
    const cmd = new RespondToAuthChallengeCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      ChallengeName: "SOFTWARE_TOKEN_MFA",
      Session: session,
      ChallengeResponses: {
        USERNAME: username,
        SOFTWARE_TOKEN_MFA_CODE: code,
        SECRET_HASH: hashSecret(username),
      },
    });
    const out = await cognito.send(cmd);
    res.json({
      idToken: out.AuthenticationResult.IdToken,
      accessToken: out.AuthenticationResult.AccessToken,
    });
  } catch (err) {
    res.status(400).json({ error: "MFA failed: " + err.message });
  }
});

// Set MFA preference
app.post("/auth/set-mfa", async (req, res) => {
  const { accessToken } = req.body;
  try {
    const cmd = new SetUserMFAPreferenceCommand({
      AccessToken: accessToken,
      SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
    });
    await cognito.send(cmd);
    res.json({ message: "MFA set to TOTP for this user" });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 6000;
app.listen(PORT, () => console.log(`Auth service (Cognito) running on ${PORT}`));
