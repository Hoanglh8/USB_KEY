import { notification } from 'antd';
import { generateKeyPair, sharedKey } from 'curve25519-js';
import { useEffect, useRef, useState } from 'react';
import { AES, enc } from 'crypto-js';
const serial = {};
const Buffer = require('buffer/').Buffer;

serial.getPorts = function () {
  return navigator.usb.getDevices().then((devices) => {
    return devices.map((device) => new serial.Port(device));
  });
};

let BOB_PUB = null;

let handshakeState = 0;
let finalSharedKey = null; // TODO: đây chính là key để mã hóa aes128

serial.requestPort = function () {
  const filters = [
    { vendorId: 0xcafe }, // TinyUSB
    { vendorId: 0x239a }, // Adafruit
    { vendorId: 0x2e8a }, // Raspberry Pi
    { vendorId: 0x303a }, // Espressif
    { vendorId: 0x2341 }, // Arduino
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
        this.onReceiveError(error);
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
          const enc = new TextEncoder(); // always utf-8
          const textDecoder = new TextDecoder();
          let rx = textDecoder.decode(data);

          // TODO: chỗ này là do phần physic cho truyền tối đa 64 bytes 1 lần
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

            const finalSharedStr = Buffer.from(
              sharedKey(alicePriv, bobPub)
            ).toString('hex');
            // Final key
            finalSharedKey = Uint8Array.from(
              Buffer.from(finalSharedStr, 'hex')
            );

            const replyToUsb = 'key=' + alicePubVal;
            // console.log('Reply to usb : ' + replyToUsb);

            port
              ?.send(enc.encode(replyToUsb))
              .then((_) => {
                setPha2Val(true);
              })
              .catch((e) => {
                console.log(e);
              });
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
        port?.send(enc.encode('Hello')).catch((e) => {
          console.log(e);
        });
      } else {
        openNotification();
      }
    }
  };

  // Thông báo nếu chưa có connect
  const openNotification = () => {
    notification.open({
      message: 'Thông báo',
      description:
        'Bạn chưa kết nối đến USB, Vui lòng kết nối với USB trước khi gửi tin.',
      onClick: () => {
        console.log('Notification Clicked!');
      },
    });
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
        const sandId = Math.floor(1000 + Math.random() * 9000);
        const encodedString = new Buffer(sandId.toString()).toString('base64');
        const cipherTextHex = enc.Hex.stringify(enc.Utf8.parse(encodedString));
        console.log(cipherTextHex);
        const encForUsb = new TextEncoder(); // always utf-8
        setPingPong(pingPong + 1);
        if (portConnect) {
          portConnect?.send(encForUsb.encode(cipherTextHex)).catch((e) => {
            console.log(e);
          });
        } else {
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
        }
      }, 1000);
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
