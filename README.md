## Wallet Test Framework: MetaMask (Android)

A tool to automate the MetaMask wallet on android for use with Wallet Test Framework.

## Installation

### Node

This project requires Nodejs version 20.6 or later.

### Dependencies

```bash
npm install
```

### Android Application

The glue requires the MetaMask app installed on a real device. The app can be installed from the [Play Store](https://play.google.com/store/apps/details?id=io.metamask).

Note that running the tests will wipe your private keys off of the device.

## Building

```bash
npm run build
```

### Tests & Linting (Optional)

```bash
npm test
```

## Running

Running these tests requires launching two executables: an appium server, and the glue.

### Appium

Getting appium to launch properly can be difficult. Follow their guides for more information.

```bash
npx appium
```

<!-- TODO: mention installing uiautomator2 -->

### Tests

```bash
npx glue-metamask-android
```
