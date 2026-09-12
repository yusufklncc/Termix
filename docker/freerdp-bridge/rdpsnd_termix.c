/*
 * An rdpsnd device that plays nowhere.
 *
 * FreeRDP delivers remote audio through a device plugin -- alsa, pulse, oss --
 * each of which opens a sound card. The bridge has no sound card and wants no
 * sound card: the audio belongs in the viewer's browser, several hops away.
 * So this device does everything a device does except the last step, and hands
 * the samples to the bridge instead of to hardware.
 *
 * It is a separate shared object rather than part of bridge.c because that is
 * how FreeRDP loads a device: by name, with dlopen, looking for
 * freerdp_rdpsnd_client_subsystem_entry. The static addins built into the
 * library are tried first and this is the fallback the loader reaches when
 * none of them is called "termix".
 *
 * The samples travel the other way, to a function the bridge defines. It is
 * declared weak so that this object loaded into anything else -- a stray
 * xfreerdp, a test -- discards audio rather than failing to resolve a symbol.
 */

#include <stdlib.h>
#include <string.h>

#include <freerdp/client/rdpsnd.h>
#include <freerdp/codec/audio.h>

__attribute__((weak)) void termix_audio_sink(const void* pcm, size_t bytes, unsigned rate,
                                             unsigned channels, unsigned bits);

typedef struct
{
	rdpsndDevicePlugin device;
	AUDIO_FORMAT format;
	UINT32 volume;
	BOOL open;
} termixDevice;

/*
 * Linear PCM only.
 *
 * A device advertises what it can play and FreeRDP converts to it -- the DSP
 * is built with ffmpeg here, so a server offering AAC or ADPCM is decoded on
 * the way in. Claiming to understand compressed formats would mean carrying
 * them to the browser, which then has to decode a format it was never told
 * about, so the conversion is better here where it already exists.
 */
static BOOL termix_format_supported(rdpsndDevicePlugin* device, const AUDIO_FORMAT* format)
{
	(void)device;
	if (!format)
		return FALSE;

	return format->wFormatTag == WAVE_FORMAT_PCM && format->wBitsPerSample == 16 &&
	       (format->nChannels == 1 || format->nChannels == 2);
}

/*
 * What to ask for when the server offers a choice.
 *
 * 44100 stereo because it is what every browser's audio context runs at, so
 * nothing has to resample; a mismatch here would be paid for in the worker on
 * every buffer.
 */
static BOOL termix_default_format(rdpsndDevicePlugin* device, const AUDIO_FORMAT* desired,
                                  AUDIO_FORMAT* defaultFormat)
{
	(void)device;
	if (!defaultFormat)
		return FALSE;

	if (desired && termix_format_supported(device, desired))
	{
		*defaultFormat = *desired;
		defaultFormat->data = NULL;
		defaultFormat->cbSize = 0;
		return TRUE;
	}

	defaultFormat->wFormatTag = WAVE_FORMAT_PCM;
	defaultFormat->nChannels = 2;
	defaultFormat->nSamplesPerSec = 44100;
	defaultFormat->wBitsPerSample = 16;
	defaultFormat->nBlockAlign = 4;
	defaultFormat->nAvgBytesPerSec = 44100 * 4;
	defaultFormat->cbSize = 0;
	defaultFormat->data = NULL;
	return TRUE;
}

static BOOL termix_open(rdpsndDevicePlugin* device, const AUDIO_FORMAT* format, UINT32 latency)
{
	termixDevice* self = (termixDevice*)device;
	(void)latency;
	if (!self)
		return FALSE;

	if (format)
	{
		self->format = *format;
		self->format.data = NULL;
		self->format.cbSize = 0;
	}
	self->open = TRUE;
	return TRUE;
}

static void termix_close(rdpsndDevicePlugin* device)
{
	termixDevice* self = (termixDevice*)device;
	if (self)
		self->open = FALSE;
}

static UINT termix_play(rdpsndDevicePlugin* device, const BYTE* data, size_t size)
{
	termixDevice* self = (termixDevice*)device;
	if (!self || !data || size == 0)
		return 0;

	if (termix_audio_sink)
	{
		termix_audio_sink(data, size, self->format.nSamplesPerSec, self->format.nChannels,
		                  self->format.wBitsPerSample);
	}

	/*
	 * How long these samples last, in milliseconds.
	 *
	 * rdpsnd uses the return value to pace the server: it is the latency the
	 * device is reporting, and a device that always says zero invites the
	 * server to send faster than anything can play.
	 */
	const UINT32 bytesPerSecond = self->format.nAvgBytesPerSec;
	if (bytesPerSecond == 0)
		return 0;
	return (UINT)((size * 1000u) / bytesPerSecond);
}

/* The server sets a volume; there is no mixer here, so it is remembered and
 * handed back rather than refused, which would make the server retry. */
static UINT32 termix_get_volume(rdpsndDevicePlugin* device)
{
	termixDevice* self = (termixDevice*)device;
	return self ? self->volume : 0xFFFFFFFF;
}

static BOOL termix_set_volume(rdpsndDevicePlugin* device, UINT32 value)
{
	termixDevice* self = (termixDevice*)device;
	if (!self)
		return FALSE;
	self->volume = value;
	return TRUE;
}

static void termix_free(rdpsndDevicePlugin* device)
{
	free(device);
}

UINT freerdp_rdpsnd_client_subsystem_entry(PFREERDP_RDPSND_DEVICE_ENTRY_POINTS pEntryPoints)
{
	if (!pEntryPoints || !pEntryPoints->pRegisterRdpsndDevice)
		return ERROR_INVALID_PARAMETER;

	termixDevice* device = (termixDevice*)calloc(1, sizeof(termixDevice));
	if (!device)
		return CHANNEL_RC_NO_MEMORY;

	device->volume = 0xFFFFFFFF;
	termix_default_format(&device->device, NULL, &device->format);

	device->device.FormatSupported = termix_format_supported;
	device->device.DefaultFormat = termix_default_format;
	device->device.Open = termix_open;
	device->device.Play = termix_play;
	device->device.Close = termix_close;
	device->device.Free = termix_free;
	device->device.GetVolume = termix_get_volume;
	device->device.SetVolume = termix_set_volume;

	pEntryPoints->pRegisterRdpsndDevice(pEntryPoints->rdpsnd, &device->device);
	return CHANNEL_RC_OK;
}
