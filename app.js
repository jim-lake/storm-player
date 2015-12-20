'use strict';

if( require('semver').lt(process.version,'4.2.1') ) {
  console.error("Your node version:",process.version);
  console.error("butler-api requires node 4.2.1 or greater.");
  process.exit(-1);
}

const _ = require('lodash');
const dgram = require('dgram');
const async = require('async');
const NodeTunes = require('nodetunes');
const Speaker = require('speaker');
const AlacDecoderStream = require('alac2pcm');
const mdns = require('mdns');
const request = require('request');

const STARTUP_DELAY_MS = 2000;
const PREBUFFER_LENGTH = 44100*2*2;

const speaker = new Speaker({
  channels: 2,
  bitDepth: 16,
  sampleRate: 44100,
});

let g_airTunesServer = null;

let g_codec = '96 L16/44100/2';
let g_decoder = null;

let g_preBufferList = null;
let g_preBufferLength = 0;

let g_slaveList = [];
let g_audioSlaveList = [];

const g_sendSocket = new dgram.createSocket('udp6');
g_sendSocket.unref();

const browser_opts = {
  resolverSequence: [
    mdns.rst.DNSServiceResolve(),
    'DNSServiceGetAddrInfo' in mdns.dns_sd ? mdns.rst.DNSServiceGetAddrInfo() : mdns.rst.getaddrinfo({families:[4]}),
    mdns.rst.makeAddressesUnique(),
  ],
}
const browser = mdns.createBrowser(mdns.tcp('raop'),browser_opts);
browser.on('serviceUp',onServiceUp);
browser.on('serviceDown',(service) => {
  console.log("service down:",service.name);
});
browser.on('error',(error) => {
  console.log("browser error:",error);
});
browser.start();

function onServiceUp(service) {
  const name = service.name;
  if (g_airTunesServer && name == g_airTunesServer.mdnsName) {
    console.log("onServiceUp: Ignoring self:",g_airTunesServer.mdnsName);
  } else {
    const ip = service.addresses.pop();
    const port = service.port;
    const url = "http://" + ip + ":" + port;
    const opts = {
      url,
      method: 'OPTIONS',
      headers: {
        'Connection': 'close',
      },
    };
    request(opts,(err,res,body) => {
      if (err) {
        console.error("onServiceUp: browser request(" + url + ") error:",err,body);
      } else if (res) {
        const pub = res.headers['public'];
        if (pub && pub.indexOf('STORM') > 0) {
          checkStormServer(url,service);
        } else {
          console.log("onServiceUp: Skipping non-storm server:",service.name);
        }
      }
    });
  }
}

function checkStormServer(url) {
  const opts = {
    url,
    method: 'STORM',
    headers: {
      'Connection': 'close',
    },
    json: true,
  };
  request(opts,(err,res,body) => {
    if (err) {
      console.error("checkStormServer: err:",err,body);
    } else if (res && body) {
      if (body.is_master) {
        if (g_isMaster) {
          masterConflict(url);
        } else if (g_masterServerUrl) {
          masterTransition(url);
        } else {
          masterFound(url);
        }
      } else if (body.master_server_url) {
        checkStormServer(body.master_server_url);
      }
    } else {
      console.error("checkStormServer: bad response:",err,body);
    }
  });
}
function masterConflict(url) {
  console.error("masterConflict:",url);
}
function masterTransition(url) {
  if (g_masterServerUrl == url) {
    console.log("masterTransition: ignore dup master:",url);
  } else {
    console.error("masterTransition: not implemented transition:",url);
  }
}
function masterFound(url) {
  g_masterServerUrl = url;
  maybeStartServer();
}
function masterPlaybackStart(args) {
  const opts = {
    method: 'STORM_START',
    headers: {
      'Connection': 'close',
    },
    body: args,
    json: true,
  };
  requestAll(opts,(err,results) => {
    if (err) {
      console.error("masterPlaybackStart: request err:",err);
    } else {
      _.each(results,(result) => {
        const audio_slave = {
          host: result.slave.host,
          port: result.body.audio_port,
        };
        g_audioSlaveList.push(audio_slave);
        console.log("masterPlaybackStart: added audio slave:",audio_slave);
      });
    }
  });
}

function requestAll(opts,done) {
  if (!done) {
    done = function() {};
  }
  const results = [];
  async.each(g_slaveList,(slave,done) => {
    const request_opts = _.extend({},opts,{
      url: "http://" + slave.host + ":" + slave.port,
    });
    request(request_opts,(err,response,body) => {
      if (!err) {
        results.push({
          slave,
          body,
        });
      }
      done(err);
    });
  },(err) => {
    done(err,results);
  });
}

function masterAudio(data) {
  _.each(g_audioSlaveList,(slave,index) => {
    const buf = data.message;
    g_sendSocket.send(buf,0,buf.length,slave.port,slave.host,(err) => {
      if (err) {
        console.error("masterAudio: send err:",err);
      }
    });
  });
}

function slaveRegister(info) {
  const opts = {
    url: g_masterServerUrl,
    method: 'STORM_REGISTER',
    headers: {
      'Connection': 'close',
    },
    body: {
      port: info.port,
    },
    json: true,
  };
  request(opts,(err,res,body) => {
    if (err) {
      console.error("slaveRegister: request err:",err,body);
    } else if (!res || res.status != 200) {
      console.error("slaveRegister: register failed:",res,body);
    }
  });
}

setTimeout(maybeStartServer,STARTUP_DELAY_MS);

let g_masterServerUrl = false;
let g_isMaster = false;

function rtspStorm(req,res) {
  console.log("STORM check");
  let ret = {
    is_master: g_isMaster,
  };
  if (!g_isMaster) {
    ret.master_server_url = g_masterServerUrl;
  }
  res.send(ret);
}

function rtspStormStart(req,res) {
  if (g_isMaster) {
    res.status(400).send("Im master so you cant start me.");
  } else {
    console.log("rtspStormStart:",req.body);
    playbackStart(req.body);

    const ret = {
      audio_port: g_airTunesServer.rtspServer.ports[0],
    };
    res.send(ret);
  }
}

function getParam(req,param) {
  let result;
  if (req.body) {
    result = req.body[param];
  }
  return result;
}

function rtspStormRegister(req,res) {
  if (g_isMaster) {
    const port = getParam(req,'port');
    if (!port) {
      res.status(400).send("port is required");
    } else {
      const client = {
        host: req.ip,
        port,
      };
      if (!_.find(g_slaveList,_.isEqual.bind(null,client))) {
        g_slaveList.push(client);
        console.log("rtspStormRegister: added client:",client);
      } else {
        console.log("rtspStormRegister: client already exists:",client);
      }
    }
  } else {
    res.status(412).send("Im not a master so you cant register");
  }
}

function maybeStartServer(done) {
  if (!done) {
    done = function() {};
  }

  if (g_airTunesServer) {
    console.log("maybeStartServer: Already started, harmless");
    done('already_started');
  } else {
    if (!g_masterServerUrl) {
      g_isMaster = true;
    }

    const server_opts = {
      serverName: 'Cloud Theater',
      rtspMethods: {
        STORM: rtspStorm,
        STORM_REGISTER: rtspStormRegister,
        STORM_START: rtspStormStart,
      },
      advertise: g_isMaster,
    };
    g_airTunesServer = startServer(server_opts,(err,info) => {
      if (err) {
        console.error("maybeStartServer: failed to start airtunes:",err);
      } else if (!g_isMaster) {
        slaveRegister(info);
        console.log("StormPlayer: Start slave server:",g_masterServerUrl);
      } else {
        console.log("StormPlayer: Start master server");
      }
      done(err);
    });
  }
}

function startServer(server_opts,done) {
  if (!done) {
    done = function() {};
  }

  const server = new NodeTunes(server_opts);
  server.on('playbackStart',onPlaybackStart);
  server.on('playbackStop',() => {
    console.log("playbackStop");
  });
  server.on('audio',onAudio);
  server.on('volumeChange',(volume) => {
    console.log("volumeChange:",volume);
  });
  server.on('progressChange',(progress) => {
    //console.log("progressChange:",progress)
  });
  server.on('flush',() => {
    console.log("flush");
  });
  server.on('teardown',() => {
    console.log("teardown");
  });
  server.on('metadataChange',(metadata) => {
    //console.log("metadataChange:",metadata);
  });
  server.on('error',(args) => {
    console.error("error:",args);
  });
  server.start(done);
  return server;
}

function onPlaybackStart(args) {
  playbackStart(args);
  if (g_isMaster) {
    args.encryption_keys = g_airTunesServer.rtspServer.getEncryptionKeys();
    masterPlaybackStart(args);
  }
}

function playbackStart(args) {
  g_airTunesServer.rtspServer.startRtp();
  if (args.encryption_keys) {
    g_airTunesServer.rtspServer.setEncryptionKeys(args.encryption_keys);
  }

  console.log("playbackStart: audioCodec:",args.audioCodec);
  g_codec = args.audioCodec;
  if (g_codec == '96 AppleLossless') {
    const audioOptions = args.audioOptions;
    const decoderOptions = {
      frameLength: parseInt(audioOptions[1], 10),
      compatibleVersion: parseInt(audioOptions[2], 10),
      bitDepth: parseInt(audioOptions[3], 10),
      pb: parseInt(audioOptions[4], 10),
      mb: parseInt(audioOptions[5], 10),
      kb: parseInt(audioOptions[6], 10),
      channels: parseInt(audioOptions[7], 10),
      maxRun: parseInt(audioOptions[8], 10),
      maxFrameBytes: parseInt(audioOptions[9], 10),
      avgBitRate: parseInt(audioOptions[10], 10),
      sampleRate: parseInt(audioOptions[11], 10)
    };

    g_decoder = new AlacDecoderStream(decoderOptions);
  }
  g_preBufferList = [];
  g_preBufferLength = 0;
}

function onAudio(data) {
  const audio = data.audio;
  if (g_isMaster) {
    masterAudio(data);
  }

  let write = null;
  if (g_preBufferList) {
    write = (buf) => {
      g_preBufferList.push(buf);
      g_preBufferLength += buf.length;
    };
  } else {
    write = (buf) => {
      speaker.write(buf);
    };
  }

  if (g_codec == '96 L16/44100/2') {
    for (let i = 0 ; i < audio.length ; i+=2) {
      const temp = audio[i];
      audio[i] = audio[i + 1];
      audio[i + 1] = temp;
    }
    write(audio);
  } else if (g_codec == '96 AppleLossless') {
    g_decoder.write(audio);
    let buf = g_decoder.read();
    while (buf != null) {
      write(buf);
      buf = g_decoder.read();
    }
  } else {
    console.error("onAudio: unsupported codec:",g_codec);
  }

  if (g_preBufferList && g_preBufferLength > PREBUFFER_LENGTH) {
    console.log("onAudio: prebuffer done, writing to speaker.");
    g_preBufferList.forEach((buf) => {
      speaker.write(buf);
    });
    g_preBufferList = null;
  }
}
