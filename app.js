'use strict';

if( require('semver').lt(process.version,'4.2.1') ) {
  console.error("Your node version:",process.version);
  console.error("butler-api requires node 4.2.1 or greater.");
  process.exit(-1);
}

const AirTunesServer = require('nodetunes');
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

let airTunesServer = null;

let g_codec = '96 L16/44100/2';
let g_decoder = null;

let g_preBufferList = null;
let g_preBufferLength = 0;

const browser_opts = {
  resolverSequence: [
    mdns.rst.DNSServiceResolve(),
    'DNSServiceGetAddrInfo' in mdns.dns_sd ? mdns.rst.DNSServiceGetAddrInfo() : mdns.rst.getaddrinfo({families:[4]}),
    mdns.rst.makeAddressesUnique(),
  ],
}

const browser = mdns.createBrowser(mdns.tcp('raop'),browser_opts);
browser.on('serviceUp',(service) => {
  const name = service.name;
  if (airTunesServer && name == airTunesServer.mdnsName) {
    console.log("Ignoring self:",airTunesServer.mdnsName);
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
        console.error("browser request(" + url + ") error:",err,body);
      } else if (res) {
        const pub = res.headers['public'];
        if (pub && pub.indexOf('STORM') > 0) {
          checkStormServer(url,service);
        } else {
          console.log("Skipping non-storm server:",service.name);
        }
      }
    });
  }
});
browser.on('serviceDown',(service) => {
  console.log("service down:",service.name);
});
browser.on('error',(error) => {
  console.log("browser error:",error);
});
browser.start();

function checkStormServer(url)
{
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
        g_master_server_url = url;
        console.log("Found storm master:",url);
      } else if (body.master_server_url) {
        checkStormServer(body.master_server_url);
      }
    } else {
      console.error("checkStormServer: bad response:",err,body);
    }
  });
}

setTimeout(maybe_start_server,STARTUP_DELAY_MS);

let g_master_server_url = false;
let g_is_master = false;

function maybe_start_server()
{
  if (!g_master_server_url) {
    g_is_master = true;
  }

  const server_opts = {
    serverName: 'Cloud Theater',
    rtspMethods: {
      STORM: function(req,res) {
        console.log("STORM check");
        let body = {
          is_master: g_is_master,
        };
        if (!g_is_master) {
          body.master_server_url = g_master_server_url;
        }
        res.send(body);
      },
    },
    advertise: g_is_master,
  };
  if (g_is_master) {
    console.log("Start master server");
  } else {
    console.log("Start slave server, master:",g_master_server_url);
  }
  airTunesServer = new AirTunesServer(server_opts);

  airTunesServer.on('clientConnected',(args) => {
    console.log("audioCodec:",args.audioCodec);
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
      console.log("decoderOptions:",decoderOptions);

      g_decoder = new AlacDecoderStream(decoderOptions);
    }
    g_preBufferList = [];
    g_preBufferLength = 0;
  });
  airTunesServer.on('audio',(audio,sequence_num,rtp_ts) => {
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
      console.log("unsupported codec:",g_codec);
    }

    if (g_preBufferList && g_preBufferLength > PREBUFFER_LENGTH) {
      console.log("prebuffer done, writing to speaker.");
      g_preBufferList.forEach((buf) => {
        speaker.write(buf);
      });
      g_preBufferList = null;
    }
  });
  airTunesServer.on('volumeChange',(volume) => {
    console.log("volumeChange:",volume);
  });
  airTunesServer.on('progressChange',(progress) => {
    console.log("progressChange:",progress)
  });
  airTunesServer.on('flush',() => {
    console.log("flush");
  });
  airTunesServer.on('teardown',() => {
    console.log("teardown");
  });
  airTunesServer.on('metadataChange',(metadata) => {
    console.log("metadataChange:",metadata);
  });
  airTunesServer.on('error',(args) => {
    console.error("error:",args);
  });
  airTunesServer.start((err,result) => {
    if (err) {
      console.error("Failed to start airtunes:",err);
    } else {
      console.log("StormPlayer server started:",result);
    }
  });
}
