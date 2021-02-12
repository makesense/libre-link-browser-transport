import {
    APIError,
    isInstanceOf,
    LinkSession,
    LinkStorage,
    LinkTransport,
    SigningRequest,
} from 'anchor-link'
import styleText from './styles'
import generateQr from './qrcode'

import {fuel} from './fuel'

const AbortPrepare = Symbol()

export interface BrowserTransportOptions {
    /** CSS class prefix, defaults to `anchor-link` */
    classPrefix?: string
    /** Whether to inject CSS styles in the page header, defaults to true. */
    injectStyles?: boolean
    /** Whether to display request success and error messages, defaults to true */
    requestStatus?: boolean
    /** Local storage prefix, defaults to `anchor-link`. */
    storagePrefix?: string
    /**
     * Whether to use Greymass Fuel for low resource accounts, defaults to false.
     * Note that this service is not available on all networks.
     * Visit https://greymass.com/en/fuel for more information.
     */
    disableGreymassFuel?: boolean
    /**
     * The referring account to pass along to the Greymass Fuel API endpoint.
     * Specifying an account name will indicate to the API which account is eligible
     * to potentially receive a share of the fees generated by their application.
     */
    fuelReferrer?: string
    /**
     * Override of the supported resource provider chains.
     */
    supportedChains?: Record<string, string>
    /**
     * Set to false to not use !important styles, defaults to true.
     */
    importantStyles?: boolean
}

const defaultSupportedChains = {
    aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906: 'https://eos.greymass.com',
    '2a02a0053e5a8cf73a56ba0fda11e4d92e0238a4a2aa74fccf46d5a910746840':
        'https://jungle3.greymass.com',
    '4667b205c6838ef70ff7988f6e8257e8be0e1284a2f59699054a018f743b1d11':
        'https://telos.greymass.com',
}

class Storage implements LinkStorage {
    constructor(readonly keyPrefix: string) {}
    async write(key: string, data: string): Promise<void> {
        localStorage.setItem(this.storageKey(key), data)
    }
    async read(key: string): Promise<string | null> {
        return localStorage.getItem(this.storageKey(key))
    }
    async remove(key: string): Promise<void> {
        localStorage.removeItem(this.storageKey(key))
    }
    storageKey(key: string) {
        return `${this.keyPrefix}-${key}`
    }
}

export default class BrowserTransport implements LinkTransport {
    storage: LinkStorage

    constructor(public readonly options: BrowserTransportOptions = {}) {
        this.classPrefix = options.classPrefix || 'anchor-link'
        this.injectStyles = !(options.injectStyles === false)
        this.importantStyles = !(options.importantStyles === false)
        this.requestStatus = !(options.requestStatus === false)
        this.fuelEnabled = options.disableGreymassFuel !== true
        this.fuelReferrer = options.fuelReferrer || 'teamgreymass'
        this.storage = new Storage(options.storagePrefix || 'anchor-link')
        this.supportedChains = options.supportedChains || defaultSupportedChains
    }

    private classPrefix: string
    private injectStyles: boolean
    private importantStyles: boolean
    private requestStatus: boolean
    private fuelEnabled: boolean
    private fuelReferrer: string
    private supportedChains: Record<string, string>
    private activeRequest?: SigningRequest
    private activeCancel?: (reason: string | Error) => void
    private containerEl!: HTMLElement
    private requestEl!: HTMLElement
    private styleEl?: HTMLStyleElement
    private countdownTimer?: NodeJS.Timeout
    private closeTimer?: NodeJS.Timeout
    private prepareStatusEl?: HTMLElement

    private closeModal() {
        this.hide()
        if (this.activeCancel) {
            this.activeRequest = undefined
            this.activeCancel('Modal closed')
            this.activeCancel = undefined
        }
    }

    private setupElements() {
        if (this.injectStyles && !this.styleEl) {
            this.styleEl = document.createElement('style')
            this.styleEl.type = 'text/css'
            let css = styleText.replace(/%prefix%/g, this.classPrefix)
            if (this.importantStyles) {
                css = css
                    .split('\n')
                    .map((line) => line.replace(/;$/i, ' !important;'))
                    .join('\n')
            }
            this.styleEl.appendChild(document.createTextNode(css))
            document.head.appendChild(this.styleEl)
        }
        if (!this.containerEl) {
            this.containerEl = this.createEl()
            this.containerEl.className = this.classPrefix
            this.containerEl.onclick = (event) => {
                if (event.target === this.containerEl) {
                    event.stopPropagation()
                    this.closeModal()
                }
            }
            document.body.appendChild(this.containerEl)
        }
        if (!this.requestEl) {
            const wrapper = this.createEl({class: 'inner'})
            const closeButton = this.createEl({class: 'close'})
            closeButton.onclick = (event) => {
                event.stopPropagation()
                this.closeModal()
            }
            this.requestEl = this.createEl({class: 'request'})
            wrapper.appendChild(this.requestEl)
            wrapper.appendChild(closeButton)
            this.containerEl.appendChild(wrapper)
        }
    }

    private createEl(attrs?: {[key: string]: string}) {
        if (!attrs) attrs = {}
        const el = document.createElement(attrs.tag || 'div')
        if (attrs) {
            for (const attr of Object.keys(attrs)) {
                const value = attrs[attr]
                switch (attr) {
                    case 'src':
                        el.setAttribute(attr, value)
                        break
                    case 'tag':
                        break
                    case 'text':
                        el.appendChild(document.createTextNode(value))
                        break
                    case 'class':
                        el.className = `${this.classPrefix}-${value}`
                        break
                    default:
                        el.setAttribute(attr, value)
                }
            }
        }
        return el
    }

    private hide() {
        if (this.containerEl) {
            this.containerEl.classList.remove(`${this.classPrefix}-active`)
        }
        this.clearTimers()
    }

    private show() {
        if (this.containerEl) {
            this.containerEl.classList.add(`${this.classPrefix}-active`)
        }
    }

    private async displayRequest(request: SigningRequest) {
        this.setupElements()

        const sameDeviceRequest = request.clone()
        const returnUrl = generateReturnUrl()
        sameDeviceRequest.setInfoKey('same_device', true)
        sameDeviceRequest.setInfoKey('return_path', returnUrl)

        const sameDeviceUri = sameDeviceRequest.encode(true, false)
        const crossDeviceUri = request.encode(true, false)

        const isIdentity = request.isIdentity()
        const title = isIdentity ? 'Authenticate' : 'Sign'
        const subtitle =
            'Scan the QR-code above with another device running Anchor or click the button below to open Anchor on this device.'

        const qrEl = this.createEl({class: 'qr'})
        try {
            qrEl.innerHTML = generateQr(crossDeviceUri)
        } catch (error) {
            // eslint-disable-next-line no-console
            console.warn('Unable to generate QR code', error)
        }

        const linkEl = this.createEl({class: 'uri'})
        const linkA = this.createEl({
            tag: 'a',
            class: 'button',
            href: crossDeviceUri,
            text: 'Launch Anchor',
        })
        linkEl.appendChild(linkA)

        if (isFirefox()) {
            // this prevents firefox from killing the websocket connection once the link is clicked
            const iframe = this.createEl({
                class: 'wskeepalive',
                src: 'about:blank',
                tag: 'iframe',
            })
            linkEl.appendChild(iframe)
            linkA.addEventListener('click', (event) => {
                event.preventDefault()
                iframe.setAttribute('src', sameDeviceUri)
            })
        } else {
            linkA.addEventListener('click', (event) => {
                event.preventDefault()
                window.location.href = sameDeviceUri
            })
        }

        const infoEl = this.createEl({class: 'info'})
        const infoTitle = this.createEl({class: 'title', tag: 'span', text: title})
        infoEl.appendChild(infoTitle)

        const actionEl = this.createEl({class: 'actions'})
        actionEl.appendChild(qrEl)

        const infoSubtitle = this.createEl({class: 'subtitle', tag: 'span', text: subtitle})
        actionEl.appendChild(infoSubtitle)
        actionEl.appendChild(linkEl)

        let footnoteEl: HTMLElement
        if (isIdentity) {
            footnoteEl = this.createEl({class: 'footnote', text: "Don't have Anchor yet? "})
            const footnoteLink = this.createEl({
                tag: 'a',
                target: '_blank',
                href: 'https://greymass.com/anchor',
                text: 'Download now',
            })
            footnoteEl.appendChild(footnoteLink)
        } else {
            footnoteEl = this.createEl({
                class: 'footnote',
                text: 'Anchor signing is brought to you by ',
            })
            const footnoteLink = this.createEl({
                tag: 'a',
                target: '_blank',
                href: 'https://greymass.com',
                text: 'Greymass',
            })
            footnoteEl.appendChild(footnoteLink)
        }

        emptyElement(this.requestEl)

        const logoEl = this.createEl({class: 'logo'})
        this.requestEl.appendChild(logoEl)
        this.requestEl.appendChild(infoEl)
        this.requestEl.appendChild(actionEl)
        this.requestEl.appendChild(footnoteEl)

        this.show()
    }

    public async showLoading() {
        this.setupElements()
        emptyElement(this.requestEl)
        const infoEl = this.createEl({class: 'info'})
        const infoTitle = this.createEl({class: 'title', tag: 'span', text: 'Loading'})
        const infoSubtitle = this.createEl({
            class: 'subtitle',
            tag: 'span',
            text: 'Preparing request...',
        })
        this.prepareStatusEl = infoSubtitle

        infoEl.appendChild(infoTitle)
        infoEl.appendChild(infoSubtitle)

        const logoEl = this.createEl({class: 'logo loading'})
        this.requestEl.appendChild(logoEl)
        this.requestEl.appendChild(infoEl)

        this.show()
    }

    public onRequest(request: SigningRequest, cancel: (reason: string | Error) => void) {
        this.activeRequest = request
        this.activeCancel = cancel
        this.displayRequest(request).catch(cancel)
    }

    public onSessionRequest(
        session: LinkSession,
        request: SigningRequest,
        cancel: (reason: string | Error) => void
    ) {
        if (session.metadata.sameDevice) {
            request.setInfoKey('return_path', generateReturnUrl())
        }

        if (session.type === 'fallback') {
            this.onRequest(request, cancel)
            if (session.metadata.sameDevice) {
                // trigger directly on a fallback same-device session
                window.location.href = request.encode()
            }
            return
        }

        this.activeRequest = request
        this.activeCancel = cancel
        this.setupElements()

        const timeout = session.metadata.timeout || 60 * 1000 * 5
        const deviceName = session.metadata.name

        const infoTitle = this.createEl({class: 'title', tag: 'span', text: 'Sign'})
        const expires = this.getExpiration(request, timeout)

        const updateCountdown = () => {
            infoTitle.textContent = `Sign - ${countdownFormat(expires)}`
        }
        this.countdownTimer = setInterval(updateCountdown, 200)
        updateCountdown()

        const infoEl = this.createEl({class: 'info'})
        infoEl.appendChild(infoTitle)

        let subtitle: string
        if (deviceName && deviceName.length > 0) {
            subtitle = `Please open your Anchor Wallet on your device “${deviceName}” to review and sign the transaction.`
        } else {
            subtitle = 'Please review and sign the transaction in the linked wallet.'
        }

        const infoSubtitle = this.createEl({class: 'subtitle', tag: 'span', text: subtitle})
        infoEl.appendChild(infoSubtitle)

        emptyElement(this.requestEl)
        const logoEl = this.createEl({class: 'logo'})
        this.requestEl.appendChild(logoEl)
        this.requestEl.appendChild(infoEl)
        this.show()

        if (isAppleHandheld() && session.metadata.sameDevice) {
            window.location.href = 'anchor://link'
        }
    }

    private clearTimers() {
        if (this.closeTimer) {
            clearTimeout(this.closeTimer)
            this.closeTimer = undefined
        }
        if (this.countdownTimer) {
            clearTimeout(this.countdownTimer)
            this.countdownTimer = undefined
        }
    }

    getExpiration(request: SigningRequest, timeout = 0) {
        // Get expiration of the transaction
        const {expiration} = request.getRawTransaction()
        if (expiration.equals(0)) {
            // If no expiration is present, use the timeout on the session
            return new Date(Date.now() + timeout)
        } else {
            return expiration.toDate()
        }
    }

    public async showFee(request: SigningRequest, fee: string) {
        this.activeRequest = request
        const cancelPromise = new Promise((resolve, reject) => {
            this.activeCancel = (reason) => {
                let error: Error
                if (typeof reason === 'string') {
                    error = new Error(reason)
                } else {
                    error = reason
                }
                error[AbortPrepare] = true
                reject(error)
            }
        })

        this.setupElements()
        emptyElement(this.requestEl)
        const feeEl = this.createEl({class: 'fee'})

        const feeTitle = this.createEl({class: 'title', tag: 'div', text: 'Transaction Fee'})
        const feeSubtitle = this.createEl({
            class: 'subtitle',
            tag: 'span',
            text: `Your account lacks the network resources for this transaction and it cannot be covered for free.`,
        })

        const feePart1 = this.createEl({
            tag: 'span',
            text: 'You can try to ',
        })
        const feeBypass = this.createEl({
            tag: 'a',
            text: 'proceed without the fee',
        })
        const feePart2 = this.createEl({
            tag: 'span',
            text: ' or accept the fee shown below to pay for these costs.',
        })

        const feeDescription = this.createEl({
            class: 'subtitle',
            tag: 'span',
        })
        feeDescription.appendChild(feePart1)
        feeDescription.appendChild(feeBypass)
        feeDescription.appendChild(feePart2)

        feeEl.appendChild(feeTitle)
        feeEl.appendChild(feeSubtitle)
        feeEl.appendChild(feeDescription)

        const logoEl = this.createEl({class: 'fuel'})
        this.requestEl.appendChild(logoEl)
        this.requestEl.appendChild(feeEl)

        const choiceEl = this.createEl({class: 'choice'})
        const confirmEl = this.createEl({tag: 'a', class: 'button', text: `Accept Fee of ${fee}`})
        const expireEl = this.createEl({tag: 'span', text: 'Offer expires in --:--'})
        choiceEl.appendChild(expireEl)
        choiceEl.appendChild(confirmEl)
        feeEl.appendChild(choiceEl)

        const expires = this.getExpiration(request)
        const expireTimer = setInterval(() => {
            expireEl.textContent = `Offer expires in ${countdownFormat(expires)}`
            if (expires.getTime() < Date.now()) {
                this.activeCancel!('Offer expired')
            }
        }, 200)

        const footnoteEl = this.createEl({
            class: 'footnote',
            text: 'Resources offered by ',
        })
        const footnoteLink = this.createEl({
            tag: 'a',
            target: '_blank',
            href: 'https://greymass.com/en/fuel',
            text: 'Greymass Fuel',
        })
        footnoteEl.appendChild(footnoteLink)
        this.requestEl.appendChild(footnoteEl)

        const skipPromise = waitForEvent(feeBypass, 'click').then(() => {
            throw new Error('Skipped fee')
        })
        const confirmPromise = waitForEvent(confirmEl, 'click')

        this.show()

        await Promise.race([confirmPromise, skipPromise, cancelPromise]).finally(() => {
            clearInterval(expireTimer)
        })
    }

    public async prepare(request: SigningRequest, session?: LinkSession) {
        this.showLoading()
        if (!this.fuelEnabled || !session || request.isIdentity()) {
            // don't attempt to cosign id request or if we don't have a session attached
            return request
        }
        try {
            const result = fuel(
                request,
                session,
                (message: string) => {
                    if (this.prepareStatusEl) {
                        this.prepareStatusEl.textContent = message
                    }
                },
                this.supportedChains,
                this.fuelReferrer
            )
            const timeout = new Promise((r) => setTimeout(r, 5000)).then(() => {
                throw new Error('API timeout after 5000ms')
            })
            const modified = await Promise.race([result, timeout])
            const fee = modified.getInfoKey('txfee')
            if (fee) {
                await this.showFee(modified, String(fee))
            }
            return modified
        } catch (error) {
            if (error[AbortPrepare]) {
                this.hide()
                throw error
            } else {
                // eslint-disable-next-line no-console
                console.info(`Skipping resource provider: ${error.message || error}`)
            }
        }
        return request
    }

    public onSuccess(request: SigningRequest) {
        if (request === this.activeRequest) {
            this.clearTimers()
            if (this.requestStatus) {
                this.setupElements()
                const infoEl = this.createEl({class: 'info'})
                const logoEl = this.createEl({class: 'logo'})
                logoEl.classList.add('success')
                const infoTitle = this.createEl({class: 'title', tag: 'span', text: 'Success!'})
                const subtitle = request.isIdentity() ? 'Login completed.' : 'Transaction signed.'
                const infoSubtitle = this.createEl({class: 'subtitle', tag: 'span', text: subtitle})
                infoEl.appendChild(infoTitle)
                infoEl.appendChild(infoSubtitle)
                emptyElement(this.requestEl)
                this.requestEl.appendChild(logoEl)
                this.requestEl.appendChild(infoEl)
                this.show()
                this.closeTimer = setTimeout(() => {
                    this.hide()
                }, 1.5 * 1000)
            } else {
                this.hide()
            }
        }
    }

    public onFailure(request: SigningRequest, error: Error) {
        if (request === this.activeRequest && error['code'] !== 'E_CANCEL') {
            this.clearTimers()
            if (this.requestStatus) {
                this.setupElements()
                const infoEl = this.createEl({class: 'info'})
                const logoEl = this.createEl({class: 'logo'})
                logoEl.classList.add('error')
                const infoTitle = this.createEl({
                    class: 'title',
                    tag: 'span',
                    text: 'Transaction Error',
                })
                let errorMessage: string
                if (isInstanceOf(error, APIError)) {
                    if (error.name === 'eosio_assert_message_exception') {
                        errorMessage = error.details[0].message
                    } else if (error.details.length > 0) {
                        errorMessage = error.details.map((d) => d.message).join('\n')
                    } else {
                        errorMessage = error.message
                    }
                } else {
                    errorMessage = error.message || String(error)
                }
                const infoSubtitle = this.createEl({
                    class: 'subtitle',
                    tag: 'span',
                    text: errorMessage,
                })
                infoEl.appendChild(infoTitle)
                infoEl.appendChild(infoSubtitle)
                emptyElement(this.requestEl)
                this.requestEl.appendChild(logoEl)
                this.requestEl.appendChild(infoEl)
                this.show()
            } else {
                this.hide()
            }
        } else {
            this.hide()
        }
    }
}

function waitForEvent<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    eventName: K,
    timeout?: number
): Promise<HTMLElementEventMap[K]> {
    return new Promise((resolve, reject) => {
        const listener = (event: HTMLElementEventMap[K]) => {
            element.removeEventListener(eventName, listener)
            resolve(event)
        }
        element.addEventListener(eventName, listener)
        if (timeout) {
            setTimeout(() => {
                element.removeEventListener(eventName, listener)
                reject(new Error(`Timed out waiting for ${eventName}`))
            }, timeout)
        }
    })
}

function countdownFormat(date: Date) {
    const timeLeft = date.getTime() - Date.now()
    if (timeLeft > 0) {
        return new Date(timeLeft).toISOString().substr(14, 5)
    }
    return '00:00'
}

function emptyElement(el: HTMLElement) {
    while (el.firstChild) {
        el.removeChild(el.firstChild)
    }
}

/** Generate a return url that Anchor will redirect back to w/o reload. */
function generateReturnUrl() {
    if (isChromeiOS()) {
        // google chrome on iOS will always open new tab so we just ask it to open again as a workaround
        return 'googlechrome://'
    }
    if (isFirefoxiOS()) {
        // same for firefox
        return 'firefox:://'
    }
    if (isAppleHandheld() && isBrave()) {
        // and brave ios
        return 'brave://'
    }
    if (isAppleHandheld()) {
        // return url with unique fragment required for iOS safari to trigger the return url
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
        let rv = window.location.href.split('#')[0] + '#'
        for (let i = 0; i < 8; i++) {
            rv += alphabet.charAt(Math.floor(Math.random() * alphabet.length))
        }
        return rv
    }

    if (isAndroid() && isFirefox()) {
        return 'android-intent://org.mozilla.firefox'
    }

    if (isAndroid() && isEdge()) {
        return 'android-intent://com.microsoft.emmx'
    }

    if (isAndroid() && isOpera()) {
        return 'android-intent://com.opera.browser'
    }

    if (isAndroid() && isBrave()) {
        return 'android-intent://com.brave.browser'
    }

    if (isAndroid() && isAndroidWebView()) {
        return 'android-intent://webview'
    }

    if (isAndroid() && isChromeMobile()) {
        return 'android-intent://com.android.chrome'
    }

    return window.location.href
}

function isAppleHandheld() {
    return /iP(ad|od|hone)/i.test(navigator.userAgent)
}

function isChromeiOS() {
    return /CriOS/.test(navigator.userAgent)
}

function isChromeMobile() {
    return /Chrome\/[.0-9]* Mobile/i.test(navigator.userAgent)
}

function isFirefox() {
    return /Firefox/i.test(navigator.userAgent)
}

function isFirefoxiOS() {
    return /FxiOS/.test(navigator.userAgent)
}

function isOpera() {
    return (/OPR/.test(navigator.userAgent) || /Opera/.test(navigator.userAgent))
}

function isEdge() {
    return /Edg/.test(navigator.userAgent)
}

function isBrave() {
    return navigator['brave'] && typeof navigator['brave'].isBrave === 'function'
}

function isAndroid() {
    return /Android/.test(navigator.userAgent)
}

function isAndroidWebView() {
    return /wv/.test(navigator.userAgent)
}
