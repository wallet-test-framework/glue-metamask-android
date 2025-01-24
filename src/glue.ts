import { logger } from "./logger.js";
import { parseUnits } from "./units.js";
import {
    ActivateChain,
    EventMap,
    Glue,
    Report,
    RequestAccounts,
    RequestAccountsEvent,
    SendTransaction,
    SendTransactionEvent,
    SignMessage,
    SignMessageEvent,
    SignTransaction,
    SwitchEthereumChain,
} from "@wallet-test-framework/glue";
import process from "node:process";
import { Browser, remote } from "webdriverio";

function delay(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
}

class Lock<T> {
    private readonly data: T;
    private readonly queue: (() => Promise<void>)[];
    private locked: boolean;

    constructor(data: T) {
        this.data = data;
        this.queue = [];
        this.locked = false;
    }

    public unsafe(): T {
        return this.data;
    }

    public lock<R>(callback: (data: T) => Promise<R>): Promise<R> {
        if (this.locked) {
            logger.debug("Queuing");
            return new Promise<R>((res, rej) => {
                this.queue.push(() => callback(this.data).then(res).catch(rej));
            });
        }

        logger.debug("Locking");
        this.locked = true;
        return callback(this.data).finally(() => this.after());
    }

    private after() {
        if (0 === this.queue.length) {
            logger.debug("Unlocking");
            this.locked = false;
        } else {
            const item = this.queue.shift();
            logger.debug("Running task", item);
            if (typeof item === "undefined") {
                throw new Error("lock queue empty");
            }

            void item().finally(() => this.after());
        }
    }
}

type Event = {
    uuid: string;
};

class MetaMaskAndroidDriver {
    public static readonly PASSWORD = "ethereum1";
    public static readonly SEED =
        "basket cradle actor pizza similar liar suffer another all fade flag brave";
    public static readonly ACCOUNT_1 =
        "0xb7b4d68047536a87f0926a76dd0b96b3a044c8cf";
    public readonly capabilities: object;
    private readonly driver: Lock<Browser>;
    private pendingEvent: null | Event = null;
    private running: boolean;
    private windowWatcher: Promise<void>;
    private readonly glue: MetaMaskAndroidGlue;
    private lastActive: DOMHighResTimeStamp;

    private constructor(
        driver: Browser,
        glue: MetaMaskAndroidGlue,
        caps: object,
    ) {
        this.driver = new Lock(driver);
        this.running = true;
        this.windowWatcher = this.watchWindows();
        this.glue = glue;
        this.capabilities = caps;
        this.lastActive = performance.now();
    }

    public static async create(
        glue: MetaMaskAndroidGlue,
    ): Promise<MetaMaskAndroidDriver> {
        // TODO: Pass-through all the appium stuff.
        const capabilities = {
            platformName: "Android",
            "appium:automationName": "UiAutomator2",
            "appium:newCommandTimeout": 120,
        };

        const bundleCapabilities = {
            ...capabilities,
            "appium:appPackage": "io.metamask",
            "appium:appActivity": ".MainActivity",
        };

        const options = {
            hostename: "localhost",
            port: 4723,
            capabilities: bundleCapabilities,
        };

        const driver = await remote(options);

        await driver.setTimeout({ implicit: 10000 });

        return new MetaMaskAndroidDriver(driver, glue, capabilities);
    }

    private async activateApp(driver: Browser): Promise<void> {
        await driver.executeScript("mobile: startActivity", [
            { intent: "io.metamask/io.metamask.MainActivity" },
        ]);
    }

    public async unlockWithPassword(driver: Browser): Promise<void> {
        const passwordTxt = driver.$(
            '//android.widget.EditText[@resource-id="login-password-input"]',
        );
        let retries = 2;
        let exception = null;

        while (retries) {
            const appState: unknown = await driver.executeScript(
                "mobile: queryAppState",
                [{ appId: "io.metamask" }],
            );

            if (4 !== appState) {
                // The app is not in the foreground.
                await this.activateApp(driver);
            }

            try {
                await passwordTxt.clearValue();
                await passwordTxt.addValue(MetaMaskAndroidDriver.PASSWORD);
                exception = null;
                break;
            } catch (e) {
                if (await passwordTxt.isExisting()) {
                    retries -= 1;
                    exception = e;
                } else {
                    return;
                }
            }
        }

        if (exception) {
            if (exception instanceof Error) {
                throw exception;
            } else {
                throw new Error("Unable to unlock");
            }
        }

        const unlockBtn = driver.$(
            '//android.widget.Button[@content-desc="UNLOCK"]',
        );

        while (await unlockBtn.isExisting()) {
            await unlockBtn.click();
        }
    }

    private async emitRequestAccounts(driver: Browser): Promise<Event> {
        logger.debug("emitting requestaccounts");

        const editBtn = driver.$(
            '(//android.widget.TextView[@text="Edit"])[1]',
        );
        await editBtn.click();

        // XXX: MetaMask doesn't display the full address anywhere in this
        //      dialog, so we check for the address the seed phrase would
        //      create and return that.
        const account = driver.$(
            '//android.widget.TextView[@text="0xb7B4...C8Cf"]',
        );

        if (!(await account.isExisting())) {
            throw new Error("couldn't find account in request accounts");
        }

        const backBtn = driver.$(
            '//android.view.ViewGroup[@resource-id="sheet-header-back-button"]',
        );
        await backBtn.click();

        const uuid = crypto.randomUUID();

        this.glue.emit(
            "requestaccounts",
            new RequestAccountsEvent(uuid, {
                accounts: [MetaMaskAndroidDriver.ACCOUNT_1],
            }),
        );

        return { uuid };
    }

    private async emitSendTransaction(driver: Browser): Promise<Event> {
        logger.debug("emitting sendtransaction");

        let data;
        try {
            await driver
                .$('//android.view.ViewGroup[@content-desc="View Data"]')
                .click();

            data = await driver
                .$(
                    '//android.widget.TextView[@text="Hex data: "]/following-sibling::*//*[starts-with(@text, "0x")]',
                )
                .getAttribute("text");

            await driver
                .$('//android.view.ViewGroup[@content-desc="\uF3CF"]')
                .click();
        } catch (_e) {
            data = "0x";
        }

        const to = driver
            .$('//android.view.ViewGroup[@resource-id="add-address-button"]')
            .getAttribute("content-desc")
            .then((text) => text.split(",")[0])
            .catch(() =>
                driver
                    .$(
                        '//android.widget.TextView[@text="To:"]/following-sibling::*//*[@text="Account 1"]',
                    )
                    .isExisting()
                    .then((exists) =>
                        exists ? MetaMaskAndroidDriver.ACCOUNT_1 : "0x",
                    ),
            );

        // TODO: This finds "Account 1" in the "To" address as well.
        const from = driver
            .$('//android.widget.TextView[@text="Account 1"]')
            .isExisting()
            // MetaMask doesn't display the full from address on the modal.
            .then((exists) =>
                exists ? MetaMaskAndroidDriver.ACCOUNT_1 : "0x",
            );

        const value = driver
            .$(
                '//*[@resource-id="account-balance"]/parent::*//*[@text="Confirm"]/following-sibling::*[@text]',
            )
            .getAttribute("text")
            .then((text) => text.split(" ")[0])
            .then((text) => parseUnits(text.trim(), 18))
            .then((big) => big.toString());

        const uuid = crypto.randomUUID();
        const event = {
            from: await from,
            to: await to,
            data,
            value: await value,
        };
        this.glue.emit(
            "sendtransaction",
            new SendTransactionEvent(uuid, event),
        );
        return { uuid };
    }

    private async emitSignMessage(driver: Browser): Promise<Event> {
        logger.debug("emitting signmessage");

        const message = await driver
            .$(
                '//android.widget.TextView[@text="Message:"]/following-sibling::android.widget.TextView[@text]',
            )
            .getAttribute("text")
            .then((text) => text.trim());

        const uuid = crypto.randomUUID();
        this.glue.emit(
            "signmessage",
            new SignMessageEvent(uuid, {
                message,
            }),
        );
        return { uuid };
    }

    private isPersonalSignModal(driver: Browser): Promise<boolean> {
        return driver
            .$(
                '//android.view.ViewGroup[@resource-id="personal-signature-request"]',
            )
            .isExisting();
    }

    private async isSendTransactionModal(driver: Browser): Promise<boolean> {
        const pill = driver.$(
            '//android.view.ViewGroup[@resource-id="APPROVAL_TAG_URL_ORIGIN_PILL"]',
        );
        const pillExists = pill.isExisting();

        const toExists = driver
            .$('//android.widget.TextView[@text="To:"]')
            .isExisting();

        return (await pillExists) && (await toExists);
    }

    private async isConnectAccountModal(driver: Browser): Promise<boolean> {
        const connectAccountModal = driver.$(
            '//android.view.ViewGroup[@resource-id="permission-network-permissions-container"]',
        );

        return await connectAccountModal.isExisting();
    }

    private async event(driver: Browser): Promise<Event | null> {
        await this.unlockWithPassword(driver);

        // Do all the checks simultaneously to save time.
        const eventHandlers = [
            {
                active: this.isConnectAccountModal(driver),
                handler: (b: Browser) => this.emitRequestAccounts(b),
            },
            {
                active: this.isSendTransactionModal(driver),
                handler: (b: Browser) => this.emitSendTransaction(b),
            },
            {
                active: this.isPersonalSignModal(driver),
                handler: (b: Browser) => this.emitSignMessage(b),
            },
        ];

        let handler = null;

        for (const pair of eventHandlers) {
            if (await pair.active) {
                if (handler) {
                    throw Error("bug: multiple event emitters triggered");
                }
                handler = pair.handler;
            }
        }

        if (handler) {
            return await handler(driver);
        } else {
            return null;
        }
    }

    private async watchWindows(): Promise<void> {
        try {
            while (this.running) {
                await delay(500);

                if (this.pendingEvent) {
                    continue;
                }

                const appState: unknown = await this.driver
                    .unsafe()
                    .executeScript("mobile: queryAppState", [
                        { appId: "io.metamask" },
                    ]);

                const now = performance.now();

                if (4 !== appState) {
                    // The app is not in the foreground.

                    if (now - this.lastActive > 30000.0) {
                        // Need to flip back to the app every so often to check
                        // for events.
                        this.lastActive = now; // Prevent spamming.
                        await this.driver.lock(async (driver) => {
                            await this.activateApp(driver);
                        });
                    }
                    continue;
                }

                this.lastActive = now;

                await this.driver.lock(async (driver) => {
                    this.pendingEvent = await this.event(driver);
                });
            }
        } catch (e) {
            console.error(e);
            process.exit(1);
        }
    }

    public lock<T>(
        callback: (wb: Browser) => Promise<T>,
        event_uuid?: string,
    ): Promise<T> {
        let promise = this.driver.lock(callback);
        if (event_uuid !== undefined) {
            promise = promise.finally(() => {
                if (event_uuid !== this.pendingEvent?.uuid) {
                    throw new Error(
                        "bug: pending event doesn't match executed event",
                    );
                }
                this.pendingEvent = null;
            });
        }
        return promise;
    }

    public async setup(): Promise<void> {
        await this.driver.lock(async (driver) => {
            // Get through the intro screen.
            try {
                const getStartedBtn = driver.$(
                    '//android.widget.Button[@content-desc="Get started"]',
                );
                await getStartedBtn.waitForExist();
                await getStartedBtn.click();
            } catch (_) {
                // Sometimes the "Get Started" button isn't there!
            }

            // Wait for and click the Import Wallet button.
            const importWalletBtn = driver.$(
                '//android.widget.Button[@content-desc="wallet-setup-screen-import-from-seed-button-id"]',
            );
            await importWalletBtn.waitForExist();
            await importWalletBtn.click();

            // Deny Metrics
            const denyBtn = driver.$(
                '//android.widget.Button[@content-desc="No thanks"]',
            );
            await denyBtn.click();

            try {
                const scrollBtn = driver.$(
                    '//android.view.ViewGroup[@resource-id="terms-of-use-scroll-end-arrow-button-id"]',
                );
                await scrollBtn.click();

                const termsBtn = driver.$(
                    '//android.view.ViewGroup[@resource-id="terms-of-use-checkbox"]',
                );
                await termsBtn.click();

                const agreeBtn = driver.$(
                    '//android.widget.Button[@content-desc="Accept"]',
                );
                await agreeBtn.waitForEnabled();
                await agreeBtn.click();
            } catch (_) {
                // If MetaMask isn't completely reset, the terms don't pop up.
            }

            // Enter the seed phrase.
            const showBtn = driver.$(
                '(//android.view.ViewGroup[@content-desc="Show"])[1]',
            );
            await showBtn.click();

            const seedTextView = driver.$(
                '//android.widget.EditText[@text="Enter your Secret Recovery Phrase"]',
            );
            await seedTextView.clearValue();
            await seedTextView.addValue(MetaMaskAndroidDriver.SEED);

            const newPw = driver.$(
                '//android.widget.EditText[@resource-id="create-password-first-input-field"]',
            );
            await newPw.clearValue();
            await newPw.addValue(MetaMaskAndroidDriver.PASSWORD);

            const confirmPw = driver.$(
                '//android.widget.EditText[@resource-id="create-password-second-input-field"]',
            );
            await confirmPw.clearValue();
            await confirmPw.addValue(MetaMaskAndroidDriver.PASSWORD);

            const fingerprintSwitch = driver.$(
                //'//android.widget.Switch[@resource-id="login-with-biometrics-switch"]',
                "//android.widget.Switch",
            );
            await fingerprintSwitch.click();

            const importBtn = driver.$(
                '//android.widget.Button[@content-desc="import-from-seed-screen-submit-button-id"]',
            );
            await importBtn.click();

            const doneBtn = driver.$(
                '//android.widget.Button[@content-desc="Done"]',
            );
            await doneBtn.click();

            const secBtn = driver.$(
                '//android.widget.Button[@content-desc="No thanks"]',
            );
            while (await secBtn.isExisting()) {
                try {
                    await secBtn.click();
                } catch (_) {
                    // The button can disappear between the `isExisting` and
                    // the `click`.
                }
            }
        });
    }

    async stop(): Promise<void> {
        this.running = false;
        await this.driver.lock(async (driver) => {
            await driver.deleteSession();
        });
    }
}

export class MetaMaskAndroidGlue extends Glue {
    private static async buildDriver(
        glue: MetaMaskAndroidGlue,
    ): Promise<MetaMaskAndroidDriver> {
        const metamask = await MetaMaskAndroidDriver.create(glue);
        await metamask.setup();
        return metamask;
    }

    private readonly driver;
    public readonly reportReady: Promise<Report>;
    private readonly resolveReport: (report: Report) => unknown;

    constructor() {
        super();
        this.driver = MetaMaskAndroidGlue.buildDriver(this);

        let resolveReport;
        this.reportReady = new Promise((res) => {
            resolveReport = res;
        });

        if (!resolveReport) {
            throw new Error("Promise didn't assign resolve function");
        }

        this.resolveReport = resolveReport;
    }

    async launch(url: string): Promise<void> {
        const cb = await this.driver;
        await cb.lock(async (driver) => {
            await driver.executeScript("mobile: deepLink", [
                {
                    url: url,
                    package: "com.android.chrome",
                },
            ]);

            const wcBtn = driver.$(
                '//android.widget.Button[@resource-id="walletConnect"]',
            );
            await wcBtn.click();

            const allWalletsBtn = driver.$(
                '//android.widget.Button[@text="Select Wallet"]',
            );
            await allWalletsBtn.click();

            // TODO: This works on my phone because I have two wallets. Need to fix this for phones with only one wallet.
            const selectWallet = driver.$(
                '//android.widget.TextView[@text="MetaMask"]',
            );
            await selectWallet.click();
        });
    }

    async openNetworksMenu(driver: Browser): Promise<void> {
        const openNetBtn = driver.$(
            '//android.view.ViewGroup[@resource-id="open-networks-button"]',
        );
        await openNetBtn.click();
    }

    override async activateChain(action: ActivateChain): Promise<void> {
        const cb = await this.driver;
        const chainName = `Test Chain ${action.chainId}`;
        await cb.lock(async (driver) => {
            await cb.unlockWithPassword(driver);
            await this.openNetworksMenu(driver);

            const addBtn = driver.$(
                '//android.widget.Button[@content-desc="Add a custom network"]',
            );
            await addBtn.click();

            const nameEdit = driver.$(
                '//android.widget.EditText[@resource-id="input-network-name"]',
            );
            await nameEdit.addValue(chainName);

            const chainIdEdit = driver.$(
                '//android.widget.EditText[@resource-id="input-chain-id"]',
            );
            while (true) {
                try {
                    await chainIdEdit.clearValue();
                    await chainIdEdit.addValue(action.chainId);
                    break;
                } catch (_) {
                    // Sometimes MetaMask is fast enough to populate this field.
                }
            }

            const rpcDrop = driver.$(
                '//android.view.ViewGroup[@resource-id="drop-down-rpc-menu"]',
            );
            await rpcDrop.click();

            const addRpcBtn = driver.$(
                '//android.widget.Button[@content-desc="Add RPC URL"]',
            );
            await addRpcBtn.click();

            const urlEdit = driver.$(
                '//android.widget.EditText[@resource-id="input-rpc-url"]',
            );
            await urlEdit.addValue(action.rpcUrl);

            const confirmRpcBtn = driver.$(
                '//android.widget.Button[@resource-id="add-rpc-button"]',
            );
            await confirmRpcBtn.click();

            const symbolEdit = driver.$(
                '//android.widget.EditText[@resource-id="input-network-symbol"]',
            );
            await symbolEdit.addValue("TETH");

            const explorerDrop = driver.$(
                '//android.view.ViewGroup[@resource-id="drop-down-block-explorer-menu"]',
            );
            await explorerDrop.click();

            const addExplorerBtn = driver.$(
                '//android.widget.Button[@content-desc="Add Block Explorer URL"]',
            );
            await addExplorerBtn.click();

            const explorerEdit = driver.$(
                '//android.widget.EditText[@resource-id="block-explorer"]',
            );
            await explorerEdit.addValue("https://example.com/");

            const confirmExplorerBtn = driver.$(
                '//android.widget.Button[@resource-id="add-block-explorer-button"]',
            );
            await confirmExplorerBtn.click();

            const confirmNetBtn = driver.$(
                '//android.widget.Button[@resource-id="add-custom-network-button"]',
            );
            while (await confirmNetBtn.isExisting()) {
                try {
                    await confirmNetBtn.click();
                } catch (_) {
                    // The button can disappear between the `isExisting` and
                    // the `click`.
                }
            }

            await cb.unlockWithPassword(driver);

            await this.openNetworksMenu(driver);

            const testChainMenu = driver.$(
                `//android.widget.TextView[@text="${chainName}"]/ancestor::*[@resource-id="select-with-menu"]`,
            );
            await testChainMenu.click();

            const eduBtn = driver.$(
                '//android.widget.Button[@content-desc="network-education-modal-close-button"]',
            );
            await eduBtn.click();
        });
    }

    override async requestAccounts(action: RequestAccounts): Promise<void> {
        const cb = await this.driver;
        await cb.lock(async (driver) => {
            let btnXpath =
                '//android.view.ViewGroup[@resource-id="permission-network-permissions-container"]/following-sibling::';
            if (action.action === "reject") {
                btnXpath +=
                    'android.widget.Button[@content-desc="cancel-button"]';
            } else if (action.action === "approve") {
                btnXpath +=
                    'android.widget.Button[@content-desc="connect-button"]';
            } else {
                throw new Error("requestAccounts: not implemented");
            }

            await driver.$(btnXpath).click();
        }, action.id);
    }

    override async signMessage(action: SignMessage): Promise<void> {
        const cb = await this.driver;
        await cb.lock(async (driver) => {
            let btnXpath;
            if (action.action === "reject") {
                btnXpath =
                    '//android.widget.Button[@content-desc="request-signature-cancel-button"]';
            } else if (action.action === "approve") {
                btnXpath =
                    '//android.widget.Button[@content-desc="request-signature-confirm-button"]';
            } else {
                throw new Error("signMessage: not implemented");
            }

            await driver.$(btnXpath).click();
        }, action.id);
    }

    override async sendTransaction(action: SendTransaction): Promise<void> {
        const cb = await this.driver;
        await cb.lock(async (driver) => {
            let btn;
            if (action.action === "reject") {
                btn = driver.$(
                    '//android.widget.Button[@content-desc="Reject"]',
                );
            } else if (action.action === "approve") {
                btn = driver.$(
                    '//android.widget.Button[@content-desc="Confirm"]',
                );
            } else {
                throw new Error("sendTransaction: not implemented");
            }
            await btn.click();
        }, action.id);
    }

    override signTransaction(_action: SignTransaction): Promise<void> {
        return Promise.reject(new Error("signTransaction: not implemented"));
    }

    override switchEthereumChain(_action: SwitchEthereumChain): Promise<void> {
        return Promise.reject(
            new Error("switchEthereumChain: not implemented"),
        );
    }

    override async report(action: Report): Promise<void> {
        await (await this.driver).stop();
        this.resolveReport(action);
    }

    public emit<E extends keyof EventMap>(
        type: E,
        ...ev: Parameters<EventMap[E]>
    ): void {
        super.emit(type, ...ev);
    }
}
