import '@sentry/tracing';

import * as Sentry from '@sentry/node';
import signale from 'signale';

import {MixstatusProcessor} from 'src/mixstatus';
import {bringOnline} from 'src/network';
import {State } from 'src/status/types';
import { ProlinkNetwork } from 'src/network';

import fs from 'fs';

Sentry.init({
  dsn: 'https://36570041fd5a4c05af76456e60a1233a@o126623.ingest.sentry.io/5205486',
  tracesSampleRate: 1,
});

async function cli() {
  signale.await('Bringing up prolink network');
  const network = await bringOnline();
  signale.success('Network online, preparing to connect');

  network.deviceManager.on('connected', d => {
    signale.star('New device: %s [id: %s]', d.name, d.id)
  });

  signale.await('Autoconfiguring network.. waiting for devices');
  await network.autoconfigFromPeers();
  signale.await('Autoconfigure successfull!');

  signale.await('Connecting to network!');
  network.connect();

  if (!network.isConnected()) {
    signale.error('Failed to connect to the network');
    return;
  }

  signale.star('Network connected! Network services initalized');

  const processor = new MixstatusProcessor();
  network.statusEmitter.on('status', s => processor.handleState(s));

  const lastTid = new Map();

  network.statusEmitter.on('status', async state => {
    const {trackDeviceId, trackSlot, trackType, trackId} = state;

    if (lastTid.get(state.deviceId) === trackId) {
      return;
    }

    lastTid.set(state.deviceId, trackId);

    console.log(trackId);

    const track = await network.db.getMetadata({
      deviceId: trackDeviceId,
      trackSlot,
      trackType,
      trackId,
    });

    if (track === null) {
      signale.warn('no track');
      return;
    }

    // Download a file from ProDJ-Link.
    const buf = await network.db.getFile({
      deviceId: state.trackDeviceId,
      trackSlot: state.trackSlot,
      trackType: state.trackType,
      track: track
    });
    if (buf) {
      fs.writeFileSync(track.fileName, buf, 'binary');
    }

    // Display the track that was emmited by the network.
    console.log(trackId, track.title);

  });

  await new Promise(r => setTimeout(r, 3000));
}

cli();
