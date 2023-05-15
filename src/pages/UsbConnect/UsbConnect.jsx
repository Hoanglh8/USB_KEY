import { notification } from 'antd';
import { generateKeyPair, sharedKey } from 'curve25519-js';
import { useEffect, useRef, useState } from 'react';
var CryptoJS = require('crypto-js');
var lastRememberSandId = -1;
var deviceSerial = '';
var usbAuthenTimeout = 0;
// import { AES, enc } from 'crypto-js';

const serial = {};
const Buffer = require('buffer/').Buffer;

serial.getPorts = function () {
  return navigator.usb.getDevices().then((devices) => {
    return devices.map((device) => new serial.Port(device));
  });
};

let BOB_PUB = null;

let handshakeState = 0;
let finalSharedKeyStr = null; // TODO: đây chính là key để mã hóa aes256
let aesIVindex = '1234567890123456'; // TODO : random string voi do dai 16 moi lan khoi dong

const restartHandshakeStateMachine = () => {
  handshakeState = 0;
};

// Thông báo nếu chưa có connect
const openNotification = (description) => {
  notification.open({
    message: 'Thông báo',
    description: description,
    onClick: () => {},
    onClose: () => {
      window.location.reload(true);
    },
  });
};

export const encryptedUsbPayload = (data) => {
  if (finalSharedKeyStr) {
    let tmpKey = finalSharedKeyStr.slice(0, 32);
    let encryptedData = CryptoJS.AES.encrypt(
      CryptoJS.enc.Utf8.parse(data),
      CryptoJS.enc.Utf8.parse(tmpKey),
      {
        // keySize: 128/8,
        iv: CryptoJS.enc.Utf8.parse(aesIVindex),
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7,
        // format: CryptoJS.format.base64
      }
    ).toString();

    // decryptedUsbPayload(encryptedData); // test

    encryptedData = '[' + encryptedData + ']';
    return encryptedData;
  }
  return null;
};

export const decryptedUsbPayload = (data) => {
  if (finalSharedKeyStr) {
    let tmpKey = finalSharedKeyStr.slice(0, 32);

    var encryptedText = CryptoJS.enc.Base64.parse(data);

    var decryptedTmp = CryptoJS.AES.decrypt(
      data,
      CryptoJS.enc.Utf8.parse(tmpKey),
      {
        // keySize: 128/8,
        iv: CryptoJS.enc.Utf8.parse(aesIVindex),
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7, // Pkcs7 // NoPadding
      }
    ).toString();

    var uint8array = Uint8Array.from(Buffer.from(decryptedTmp, 'hex'));
    var finalData = new TextDecoder().decode(uint8array);

    deviceSerial = finalData.split(',')[0];
    var rxSandId = finalData.split(',')[1];

    if (rxSandId.localeCompare(lastRememberSandId.toString()) === 0) {
      usbAuthenTimeout = 5;
    } else {
      // console.log('Invalid sandID ' + rxSandId);
      usbAuthenTimeout -= 1;
      if (usbAuthenTimeout <= 0) {
        restartHandshakeStateMachine();
        // console.log('Reset state machine');
      }
    }
    // TODO: sau khi đã kiểm tra xong valid usb & mac -> thì 3-5s sau cần thay đổi sand ID và gửi lại
    // TODO : web test các case disconnect USB (rút ra cắm lại)

    return finalData;
  }
  return null;
};

serial.requestPort = function () {
  const filters = [
    { vendorId: 0x86c }, // Bytech
  ];
  return navigator.usb
    .requestDevice({ filters: filters })
    .then((device) => new serial.Port(device));
};

serial.Port = function (device) {
  this.device_ = device;
  this.interfaceNumber = 0;
  this.endpointIn = 0;
  this.endpointOut = 0;
};

serial.Port.prototype.connect = function () {
  let readLoop = () => {
    this.device_.transferIn(this.endpointIn, 64).then(
      (result) => {
        this.onReceive(result.data);
        readLoop();
      },
      (error) => {
        // TODO reconnect device
        // console.log('Restart handshake state machine');
        usbAuthenTimeout = 0;
        restartHandshakeStateMachine();

        // console.log('usbAuthenTimeout ' + usbAuthenTimeout);

        this.disconnect();
        this.onReceiveError(error);
        openNotification(
          'Thông tin tới USB bị gián đoạn, vui lòng kết nối lại trước khi gửi tin'
        );
      }
    );
  };

  return this.device_
    .open()
    .then(() => {
      if (this.device_.configuration === null) {
        return this.device_.selectConfiguration(1);
      }
    })
    .then(() => {
      const interfaces = this.device_.configuration.interfaces;
      interfaces.forEach((element) => {
        element.alternates.forEach((elementalt) => {
          if (elementalt.interfaceClass === 0xff) {
            this.interfaceNumber = element.interfaceNumber;
            elementalt.endpoints.forEach((elementendpoint) => {
              if (elementendpoint.direction === 'out') {
                this.endpointOut = elementendpoint.endpointNumber;
              }
              if (elementendpoint.direction === 'in') {
                this.endpointIn = elementendpoint.endpointNumber;
              }
            });
          }
        });
      });
    })
    .then(() => this.device_.claimInterface(this.interfaceNumber))
    .then(() => this.device_.selectAlternateInterface(this.interfaceNumber, 0))
    .then(() =>
      this.device_.controlTransferOut({
        requestType: 'class',
        recipient: 'interface',
        request: 0x22,
        value: 0x01,
        index: this.interfaceNumber,
      })
    )
    .then(() => {
      readLoop();
    });
};

serial.Port.prototype.disconnect = function () {
  return this.device_
    .controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: 0x22,
      value: 0x00,
      index: this.interfaceNumber,
    })
    .then(() => this.device_.close());
};

serial.Port.prototype.send = function (data) {
  return this.device_.transferOut(this.endpointOut, data);
};

const UsbConnect = () => {
  const connectButtonRef = useRef(null);
  const statusRef = useRef(null);
  const commandLineRef = useRef(null);

  const [portConnect, setPortConnect] = useState(null);

  const [alicePrivVal, setAlicePrivVal] = useState(null);
  const [alicePubVal, setAlicePubVal] = useState(null);

  const [pingPong, setPingPong] = useState(0);
  const [pha2Val, setPha2Val] = useState(false);

  const addLine = (linesId, text) => {
    const senderLine = document.createElement('div');
    senderLine.className = 'line';
    const textnode = document.createTextNode(text);
    senderLine.appendChild(textnode);
    document.getElementById(linesId)?.appendChild(senderLine);
    return senderLine;
  };

  let currentReceiverLine;
  let port;

  const appendLines = (linesId, text) => {
    const lines = text.split('\r');
    if (currentReceiverLine) {
      currentReceiverLine.innerHTML = currentReceiverLine.innerHTML + lines[0];
      for (let i = 1; i < lines.length; i++) {
        currentReceiverLine = addLine(linesId, lines[i]);
      }
    } else {
      for (let i = 0; i < lines.length; i++) {
        currentReceiverLine = addLine(linesId, lines[i]);
      }
    }
  };

  const connectUsb = () => {
    port.connect().then(
      () => {
        if (statusRef.current) {
          statusRef.current.textContent = '';
        }

        if (connectButtonRef.current) {
          connectButtonRef.current.textContent = 'Disconnect';
        }

        port.onReceive = (data) => {
          const enc1 = new TextEncoder(); // always utf-8
          const textDecoder = new TextDecoder();
          let rx = textDecoder.decode(data);

          // Phần này là do phần physic cho truyền tối đa 64 bytes 1 lần
          // Độ dài key > 64 -> truyền làm 2 lần

          if (rx.includes('Hi,key=')) {
            rx = rx.replace('Hi,key=', '');
            BOB_PUB = rx;
            handshakeState = 1;
          } else if (handshakeState === 1) {
            handshakeState = 2;
            BOB_PUB += rx;

            const alicePriv = Uint8Array.from(Buffer.from(alicePrivVal, 'hex'));
            const bobPub = Uint8Array.from(Buffer.from(BOB_PUB, 'hex'));

            finalSharedKeyStr = Buffer.from(
              sharedKey(alicePriv, bobPub)
            ).toString('hex');

            const replyToUsb = 'key=' + alicePubVal;

            port
              ?.send(enc1.encode(replyToUsb))
              .then((_) => {
                usbAuthenTimeout = 5;
                setPha2Val(true);
              })
              .catch((e) => {
                restartHandshakeStateMachine(); // Bat tay lai tu dau
              });
          } else if (handshakeState === 2) {
            // HuyTV 2 = state da authen qua pha1
            if (rx.startsWith('[', 0) && rx.endsWith(']')) {
              // Remove header and footer
              rx = rx.substring(1, rx.length - 1);
              rx = decryptedUsbPayload(rx);
            }
          }

          if (data.getInt8() === 13) {
            currentReceiverLine = null;
          } else {
            appendLines('receiver_lines', textDecoder.decode(data));
          }
        };
        port.onReceiveError = (error) => {
          console.error(error);
        };
      },
      (error) => {
        if (statusRef.current) {
          statusRef.current.textContent = error;
        }
      }
    );
  };

  const connect = () => {
    if (port) {
      port.disconnect();
      if (connectButtonRef.current) {
        connectButtonRef.current.textContent = 'Connect';
      }
      if (statusRef.current) {
        statusRef.current.textContent = '';
      }

      port = null;
    } else {
      serial
        .requestPort()
        .then((selectedPort) => {
          port = selectedPort;
          connectUsb();
        })
        .catch((error) => {
          if (statusRef.current) {
            statusRef.current.textContent = error;
          }
        });
    }
  };

  const handleKeyUp = (event) => {
    const enc = new TextEncoder(); // always utf-8

    if (event.keyCode === 13) {
      if (commandLineRef.current && commandLineRef.current.value.length > 0) {
        addLine('sender_lines', commandLineRef.current.value);
        commandLineRef.current.value = '';
      }
    } else if (event.keyCode === 221) {
      // ]

      if (port) {
        setPortConnect(port);
        var hello = 'Hello,iv=' + aesIVindex;
        port?.send(enc.encode(hello)).catch((e) => {
          // console.log(e);
        });
      } else {
        openNotification(
          'Bạn chưa kết nối đến USB, Vui lòng kết nối với USB trước khi gửi tin.'
        );
      }
    }
  };

  function generateRandomBytes(length) {
    let result = '';
    const hexChars = '0123456789abcdef';
    for (let i = 0; i < length * 2; i++) {
      result += hexChars[Math.floor(Math.random() * hexChars.length)];
    }
    return result;
  }

  useEffect(() => {
    // Ramdom 32 byte
    const random = generateRandomBytes(32);
    var randomBytes = Uint8Array.from(Buffer.from(random, 'hex'));

    const keyPair = generateKeyPair(randomBytes);
    const ALICE_PRIV = Buffer.from(keyPair.private).toString('hex');
    const ALICE_PUB = Buffer.from(keyPair.public).toString('hex');
    setAlicePrivVal(ALICE_PRIV);
    setAlicePubVal(ALICE_PUB);

    serial.getPorts().then((ports) => {
      if (ports.length === 0) {
        statusRef.current.textContent = 'No device found.';
      } else {
        statusRef.current.textContent = 'Connecting...';
        // eslint-disable-next-line react-hooks/exhaustive-deps
        port = ports[0];
        connect();
      }
    });
  }, []);

  useEffect(() => {
    if (pha2Val) {
      setTimeout(() => {
        if (handshakeState === 2) {
          const sandId = Math.floor(1000 + Math.random() * 9000);
          //HuyTV
          lastRememberSandId = sandId;
          // console.log('Send sand ID: ' + lastRememberSandId);
          var sandMsg =
            sandId.toString() +
            ',' +
            Math.floor(1000 + Math.random() * 9000).toString();
          var payload = encryptedUsbPayload(sandMsg);

          const encForUsb = new TextEncoder(); // always utf-8
          setPingPong(pingPong + 1);
          if (portConnect) {
            portConnect?.send(encForUsb.encode(payload)).catch((e) => {
              restartHandshakeStateMachine();
              setPortConnect(null);
            });
          } else {
            serial.getPorts().then((ports) => {
              if (ports.length === 0) {
                handshakeState = 0;
                statusRef.current.textContent = 'No device found.';
              } else {
                restartHandshakeStateMachine();
                statusRef.current.textContent = 'Connecting...';
                // eslint-disable-next-line react-hooks/exhaustive-deps
                port = ports[0];
                connect();
              }
            });
          }

          usbAuthenTimeout -= 1;
          if (usbAuthenTimeout < 0) {
            // console.log('USB disconnected');
            restartHandshakeStateMachine();
          }
        }
      }, 3000);
    }
  }, [pingPong, pha2Val]);

  return (
    <div className="main-content">
      <h1>TinyUSB - WebUSB Serial Example</h1>
      <div className="connect-container">
        <button
          id="connect"
          ref={connectButtonRef}
          className="button black"
          onClick={connect}
        >
          Connect
        </button>
        <span id="status" ref={statusRef} />
      </div>
      <div className="container">
        <div className="sender">
          <div className="lines-header">Sender</div>
          <div className="lines-body">
            <div id="sender_lines" className="lines" />
            <input
              id="command_line"
              className="command-line"
              placeholder="Start typing ...."
              onKeyUp={handleKeyUp}
              ref={commandLineRef}
            />
          </div>
        </div>
        <div className="receiver">
          <div className="lines-header">Receiver</div>
          <div className="lines-body">
            <div id="receiver_lines" className="lines" />
          </div>
        </div>
      </div>
    </div>
  );
};

export default UsbConnect;
