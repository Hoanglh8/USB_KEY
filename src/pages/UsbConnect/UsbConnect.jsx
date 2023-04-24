import { useRef, useEffect } from 'react';
import { notification } from 'antd';
import { sharedKey } from 'curve25519-js';

const serial = {};
const Buffer = require('buffer/').Buffer;
serial.getPorts = function () {
  return navigator.usb.getDevices().then((devices) => {
    return devices.map((device) => new serial.Port(device));
  });
};

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
      var interfaces = this.device_.configuration.interfaces;
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
          const textDecoder = new TextDecoder();
          console.log(textDecoder.decode(data));
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
    if (event.keyCode === 13) {
      if (commandLineRef.current && commandLineRef.current.value.length > 0) {
        addLine('sender_lines', commandLineRef.current.value);
        commandLineRef.current.value = '';
      }
    }

    // Key nhận về từ USB
    const ALICE_PRIV =
      '77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a';
    const BOB_PUB =
      'de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f';

    const alicePriv = Uint8Array.from(Buffer.from(ALICE_PRIV, 'hex'));

    const bobPub = Uint8Array.from(Buffer.from(BOB_PUB, 'hex'));

    const secret = sharedKey(alicePriv, bobPub);
    // Key gen ra bằng thư viện
    const key = Buffer.from(secret).toString('hex');

    // Khởi tạo encode
    const enc = new TextEncoder(); // always utf-8
    // Gửi key về cho USB
    if (port) {
      port?.send(enc.encode('Hello')).catch((e) => {
        console.log(e);
      });
    } else {
      openNotification();
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

  useEffect(() => {
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
