/*
 * Termix RDP bridge — FreeRDP 3 to binary wire format.
 *
 * Copyright 2026 Termix contributors
 * Licensed under the Apache License, Version 2.0
 *
 * Takes the H.264 bitstream out of the RDP graphics pipeline and forwards it
 * untouched. FreeRDP parses only the AVC420 metablock and hands the bitstream
 * to RdpgfxClientContext::SurfaceCommand through cmd->extra; the decode that
 * would normally follow lives in the GDI implementation, which this program
 * deliberately never installs. Nothing here decodes or re-encodes a frame.
 *
 * One process per session: the listener forks on accept, so a crash inside
 * FreeRDP takes down that session alone.
 *
 * Wire format: see WIRE_FORMAT.md
 */

#include <errno.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/client/channels.h>
#include <freerdp/client/rdpgfx.h>
#include <freerdp/channels/channels.h>
#include <freerdp/channels/rdpgfx.h>
#include <freerdp/settings.h>
#include <winpr/synch.h>

#define TAG "termix-rdp-bridge"

#define DEFAULT_PORT 3390
#define MAX_FRAME_PAYLOAD (16u * 1024u * 1024u)

typedef struct
{
	rdpContext context;

	int sock;
	pthread_mutex_t writeLock;

	RdpgfxClientContext* gfx;

	UINT32 desktopWidth;
	UINT32 desktopHeight;
} termixContext;

/* ------------------------------------------------------------------ */
/* wire writer                                                         */
/* ------------------------------------------------------------------ */

static BOOL write_all(int fd, const void* buf, size_t len)
{
	const BYTE* p = (const BYTE*)buf;
	while (len > 0)
	{
		const ssize_t n = send(fd, p, len, MSG_NOSIGNAL);
		if (n <= 0)
		{
			if (n < 0 && errno == EINTR)
				continue;
			return FALSE;
		}
		p += n;
		len -= (size_t)n;
	}
	return TRUE;
}

/* Frames are emitted from the FreeRDP thread while input arrives on another,
 * so every writer takes the same lock. */
static BOOL wire_send(termixContext* ctx, const char magic[4], const void* payload, UINT32 length)
{
	BYTE header[8];
	memcpy(header, magic, 4);
	header[4] = (BYTE)(length & 0xFF);
	header[5] = (BYTE)((length >> 8) & 0xFF);
	header[6] = (BYTE)((length >> 16) & 0xFF);
	header[7] = (BYTE)((length >> 24) & 0xFF);

	pthread_mutex_lock(&ctx->writeLock);
	BOOL ok = write_all(ctx->sock, header, sizeof(header));
	if (ok && length > 0)
		ok = write_all(ctx->sock, payload, length);
	pthread_mutex_unlock(&ctx->writeLock);
	return ok;
}

static void put_u16(BYTE* p, UINT16 v)
{
	p[0] = (BYTE)(v & 0xFF);
	p[1] = (BYTE)((v >> 8) & 0xFF);
}

static void put_u32(BYTE* p, UINT32 v)
{
	p[0] = (BYTE)(v & 0xFF);
	p[1] = (BYTE)((v >> 8) & 0xFF);
	p[2] = (BYTE)((v >> 16) & 0xFF);
	p[3] = (BYTE)((v >> 24) & 0xFF);
}

static void wire_error(termixContext* ctx, const char* message)
{
	wire_send(ctx, "ERRR", message, (UINT32)strlen(message));
}

/* ------------------------------------------------------------------ */
/* graphics pipeline callbacks                                         */
/* ------------------------------------------------------------------ */

static UINT tx_ResetGraphics(RdpgfxClientContext* gfx, const RDPGFX_RESET_GRAPHICS_PDU* pdu)
{
	termixContext* ctx = (termixContext*)gfx->custom;
	BYTE payload[8];
	put_u32(payload, pdu->width);
	put_u32(payload + 4, pdu->height);
	ctx->desktopWidth = pdu->width;
	ctx->desktopHeight = pdu->height;
	wire_send(ctx, "HELO", payload, sizeof(payload));
	return CHANNEL_RC_OK;
}

static UINT tx_CreateSurface(RdpgfxClientContext* gfx, const RDPGFX_CREATE_SURFACE_PDU* pdu)
{
	termixContext* ctx = (termixContext*)gfx->custom;
	BYTE payload[7];
	put_u16(payload, pdu->surfaceId);
	put_u16(payload + 2, pdu->width);
	put_u16(payload + 4, pdu->height);
	payload[6] = (BYTE)pdu->pixelFormat;
	wire_send(ctx, "SURF", payload, sizeof(payload));
	return CHANNEL_RC_OK;
}

static UINT tx_DeleteSurface(RdpgfxClientContext* gfx, const RDPGFX_DELETE_SURFACE_PDU* pdu)
{
	termixContext* ctx = (termixContext*)gfx->custom;
	BYTE payload[2];
	put_u16(payload, pdu->surfaceId);
	wire_send(ctx, "DELS", payload, sizeof(payload));
	return CHANNEL_RC_OK;
}

static UINT tx_MapSurfaceToOutput(RdpgfxClientContext* gfx,
                                  const RDPGFX_MAP_SURFACE_TO_OUTPUT_PDU* pdu)
{
	termixContext* ctx = (termixContext*)gfx->custom;
	BYTE payload[10];
	put_u16(payload, pdu->surfaceId);
	put_u32(payload + 2, pdu->outputOriginX);
	put_u32(payload + 6, pdu->outputOriginY);
	wire_send(ctx, "SMAP", payload, sizeof(payload));
	return CHANNEL_RC_OK;
}

static UINT tx_StartFrame(RdpgfxClientContext* gfx, const RDPGFX_START_FRAME_PDU* pdu)
{
	termixContext* ctx = (termixContext*)gfx->custom;
	BYTE payload[4];
	put_u32(payload, pdu->frameId);
	wire_send(ctx, "FBEG", payload, sizeof(payload));
	return CHANNEL_RC_OK;
}

static UINT tx_EndFrame(RdpgfxClientContext* gfx, const RDPGFX_END_FRAME_PDU* pdu)
{
	termixContext* ctx = (termixContext*)gfx->custom;
	BYTE payload[4];
	put_u32(payload, pdu->frameId);
	wire_send(ctx, "FEND", payload, sizeof(payload));
	return CHANNEL_RC_OK;
}

/*
 * The pass-through. For AVC420, cmd->extra is an RDPGFX_AVC420_BITMAP_STREAM
 * whose data/length are the bitstream exactly as it came off the wire.
 *
 * The metablock is freed by rdpgfx_decode_AVC420 the moment this returns, so
 * the rects are copied into the payload here rather than referenced.
 */
static UINT tx_SurfaceCommand(RdpgfxClientContext* gfx, const RDPGFX_SURFACE_COMMAND* cmd)
{
	termixContext* ctx = (termixContext*)gfx->custom;

	static BOOL loggedFirstFrame = FALSE;
	if (!loggedFirstFrame)
	{
		loggedFirstFrame = TRUE;
		fprintf(stderr, "[%s] first surface command: codecId=%u %ux%u\n", TAG,
		        (unsigned)cmd->codecId, (unsigned)cmd->width, (unsigned)cmd->height);
		fflush(stderr);
	}

	if (cmd->codecId != RDPGFX_CODECID_AVC420)
	{
		/* AVC420 is negotiated exclusively; anything else means the server
		 * ignored our capability set and the session cannot be rendered. */
		char message[128];
		(void)snprintf(message, sizeof(message), "unsupported codecId %u, expected AVC420",
		               (unsigned)cmd->codecId);
		wire_error(ctx, message);
		return CHANNEL_RC_OK;
	}

	const RDPGFX_AVC420_BITMAP_STREAM* avc = (const RDPGFX_AVC420_BITMAP_STREAM*)cmd->extra;
	if (!avc || !avc->data || avc->length == 0)
		return CHANNEL_RC_OK;

	const UINT32 numRects = avc->meta.numRegionRects;
	const size_t headerLen = 2 + 8 + 2;
	const size_t rectsLen = (size_t)numRects * 8u;
	const size_t total = headerLen + rectsLen + avc->length;

	if (total > MAX_FRAME_PAYLOAD)
	{
		wire_error(ctx, "frame exceeds maximum payload");
		return CHANNEL_RC_OK;
	}

	BYTE* payload = (BYTE*)malloc(total);
	if (!payload)
		return CHANNEL_RC_NO_MEMORY;

	BYTE* p = payload;
	put_u16(p, (UINT16)cmd->surfaceId);
	p += 2;
	put_u16(p, (UINT16)cmd->left);
	p += 2;
	put_u16(p, (UINT16)cmd->top);
	p += 2;
	put_u16(p, (UINT16)cmd->right);
	p += 2;
	put_u16(p, (UINT16)cmd->bottom);
	p += 2;
	put_u16(p, (UINT16)numRects);
	p += 2;

	for (UINT32 i = 0; i < numRects; i++)
	{
		const RECTANGLE_16* r = &avc->meta.regionRects[i];
		put_u16(p, r->left);
		p += 2;
		put_u16(p, r->top);
		p += 2;
		put_u16(p, r->right);
		p += 2;
		put_u16(p, r->bottom);
		p += 2;
	}

	memcpy(p, avc->data, avc->length);

	wire_send(ctx, "AVCF", payload, (UINT32)total);
	free(payload);
	return CHANNEL_RC_OK;
}

static void tx_OnChannelConnected(void* context, const ChannelConnectedEventArgs* e)
{
	termixContext* ctx = (termixContext*)context;

	if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) == 0)
	{
		RdpgfxClientContext* gfx = (RdpgfxClientContext*)e->pInterface;
		ctx->gfx = gfx;
		gfx->custom = ctx;

		/* Deliberately NOT calling gdi_graphics_pipeline_init: that is what
		 * installs the decoding callbacks this bridge exists to bypass. */
		gfx->ResetGraphics = tx_ResetGraphics;
		gfx->CreateSurface = tx_CreateSurface;
		gfx->DeleteSurface = tx_DeleteSurface;
		gfx->MapSurfaceToOutput = tx_MapSurfaceToOutput;
		gfx->StartFrame = tx_StartFrame;
		gfx->EndFrame = tx_EndFrame;
		gfx->SurfaceCommand = tx_SurfaceCommand;

		fprintf(stderr, "[%s] graphics pipeline attached\n", TAG);
		fflush(stderr);
	}
	else
		freerdp_client_OnChannelConnectedEventHandler(context, e);
}

static void tx_OnChannelDisconnected(void* context, const ChannelDisconnectedEventArgs* e)
{
	termixContext* ctx = (termixContext*)context;

	if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) == 0)
		ctx->gfx = NULL;
	else
		freerdp_client_OnChannelDisconnectedEventHandler(context, e);
}

/* ------------------------------------------------------------------ */
/* connection lifecycle                                                */
/* ------------------------------------------------------------------ */

static BOOL tx_pre_connect(freerdp* instance)
{
	rdpContext* context = instance->context;
	rdpSettings* settings = context->settings;

	/* AVC420 only. AVC444 is 4:4:4 and browser decoders reject it; the
	 * alternative is transcoding to 4:2:0 on this side, which would put back
	 * exactly the CPU cost this path exists to remove. */
	if (!freerdp_settings_set_bool(settings, FreeRDP_SupportGraphicsPipeline, TRUE) ||
	    !freerdp_settings_set_bool(settings, FreeRDP_GfxH264, TRUE) ||
	    !freerdp_settings_set_bool(settings, FreeRDP_GfxAVC444, FALSE) ||
	    !freerdp_settings_set_bool(settings, FreeRDP_GfxAVC444v2, FALSE) ||
	    !freerdp_settings_set_bool(settings, FreeRDP_GfxProgressive, FALSE) ||
	    !freerdp_settings_set_bool(settings, FreeRDP_GfxSmallCache, FALSE) ||
	    !freerdp_settings_set_bool(settings, FreeRDP_GfxThinClient, FALSE))
		return FALSE;

	if (!freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, 32))
		return FALSE;

	/* These return an int and signal failure with a negative value; treating
	 * the result as a boolean rejects the success case. */
	if (PubSub_SubscribeChannelConnected(context->pubSub, tx_OnChannelConnected) < 0)
		return FALSE;
	if (PubSub_SubscribeChannelDisconnected(context->pubSub, tx_OnChannelDisconnected) < 0)
		return FALSE;

	return TRUE;
}

static BOOL tx_post_connect(freerdp* instance)
{
	termixContext* ctx = (termixContext*)instance->context;
	rdpSettings* settings = instance->context->settings;

	ctx->desktopWidth = freerdp_settings_get_uint32(settings, FreeRDP_DesktopWidth);
	ctx->desktopHeight = freerdp_settings_get_uint32(settings, FreeRDP_DesktopHeight);

	BYTE payload[8];
	put_u32(payload, ctx->desktopWidth);
	put_u32(payload + 4, ctx->desktopHeight);
	wire_send(ctx, "HELO", payload, sizeof(payload));

	/* No gdi_init here on purpose: without a GDI there is no surface to decode
	 * into, which is the point. */
	return TRUE;
}

static void tx_post_disconnect(freerdp* instance)
{
	if (!instance || !instance->context)
		return;

	termixContext* ctx = (termixContext*)instance->context;
	BYTE payload[4];
	put_u32(payload, 0);
	wire_send(ctx, "BYE ", payload, sizeof(payload));
}

/* ------------------------------------------------------------------ */
/* input                                                               */
/* ------------------------------------------------------------------ */

static UINT16 read_u16(const BYTE* p)
{
	return (UINT16)(p[0] | (p[1] << 8));
}

static UINT32 read_u32(const BYTE* p)
{
	return (UINT32)p[0] | ((UINT32)p[1] << 8) | ((UINT32)p[2] << 16) | ((UINT32)p[3] << 24);
}

static void handle_input(termixContext* ctx, const char magic[4], const BYTE* payload, UINT32 length)
{
	rdpInput* input = ctx->context.input;
	if (!input)
		return;

	if (memcmp(magic, "KEYE", 4) == 0 && length >= 4)
		freerdp_input_send_keyboard_event(input, read_u16(payload), read_u16(payload + 2));
	else if (memcmp(magic, "UNIC", 4) == 0 && length >= 4)
		freerdp_input_send_unicode_keyboard_event(input, read_u16(payload), read_u16(payload + 2));
	else if (memcmp(magic, "MOUS", 4) == 0 && length >= 6)
		freerdp_input_send_mouse_event(input, read_u16(payload), read_u16(payload + 2),
		                               read_u16(payload + 4));
	else if (memcmp(magic, "EMOU", 4) == 0 && length >= 6)
		freerdp_input_send_extended_mouse_event(input, read_u16(payload), read_u16(payload + 2),
		                                        read_u16(payload + 4));
	else if (memcmp(magic, "FACK", 4) == 0 && length >= 4)
	{
		/* Acknowledging frames is what keeps the server sending them; it also
		 * gives natural back-pressure when the browser falls behind. */
		if (ctx->gfx && ctx->gfx->SetSurfaceData)
		{
			RDPGFX_FRAME_ACKNOWLEDGE_PDU ack = { 0 };
			ack.queueDepth = SUSPEND_FRAME_ACKNOWLEDGEMENT;
			ack.frameId = read_u32(payload);
			ack.totalFramesDecoded = ack.frameId;
			if (ctx->gfx->FrameAcknowledge)
				ctx->gfx->FrameAcknowledge(ctx->gfx, &ack);
		}
	}
}

static void* input_thread(void* arg)
{
	termixContext* ctx = (termixContext*)arg;
	BYTE header[8];

	for (;;)
	{
		size_t got = 0;
		while (got < sizeof(header))
		{
			const ssize_t n = recv(ctx->sock, header + got, sizeof(header) - got, 0);
			if (n <= 0)
				goto done;
			got += (size_t)n;
		}

		const UINT32 length = read_u32(header + 4);
		if (length > MAX_FRAME_PAYLOAD)
			goto done;

		BYTE* payload = length ? (BYTE*)malloc(length) : NULL;
		if (length && !payload)
			goto done;

		got = 0;
		while (got < length)
		{
			const ssize_t n = recv(ctx->sock, payload + got, length - got, 0);
			if (n <= 0)
			{
				free(payload);
				goto done;
			}
			got += (size_t)n;
		}

		handle_input(ctx, (const char*)header, payload, length);
		free(payload);
	}

done:
	freerdp_abort_connect_context(&ctx->context);
	return NULL;
}

/* ------------------------------------------------------------------ */
/* client boilerplate                                                  */
/* ------------------------------------------------------------------ */

static BOOL tx_client_new(freerdp* instance, rdpContext* context)
{
	termixContext* ctx = (termixContext*)context;
	instance->PreConnect = tx_pre_connect;
	instance->PostConnect = tx_post_connect;
	instance->PostDisconnect = tx_post_disconnect;
	pthread_mutex_init(&ctx->writeLock, NULL);
	return TRUE;
}

static void tx_client_free(freerdp* instance, rdpContext* context)
{
	if (!context)
		return;
	termixContext* ctx = (termixContext*)context;
	pthread_mutex_destroy(&ctx->writeLock);
}

static int tx_client_start(rdpContext* context)
{
	return 0;
}

static int tx_client_stop(rdpContext* context)
{
	return 0;
}

static int RdpClientEntry(RDP_CLIENT_ENTRY_POINTS* pEntryPoints)
{
	ZeroMemory(pEntryPoints, sizeof(RDP_CLIENT_ENTRY_POINTS));
	pEntryPoints->Version = RDP_CLIENT_INTERFACE_VERSION;
	pEntryPoints->Size = sizeof(RDP_CLIENT_ENTRY_POINTS_V1);
	pEntryPoints->ContextSize = sizeof(termixContext);
	pEntryPoints->ClientNew = tx_client_new;
	pEntryPoints->ClientFree = tx_client_free;
	pEntryPoints->ClientStart = tx_client_start;
	pEntryPoints->ClientStop = tx_client_stop;
	return 0;
}

/* ------------------------------------------------------------------ */
/* session                                                             */
/* ------------------------------------------------------------------ */

/* Minimal JSON string/number extraction. The only producer of this message is
 * Termix's own backend, so a full parser would be weight without a purpose. */
static BOOL json_string(const char* json, const char* key, char* out, size_t outLen)
{
	char pattern[64];
	(void)snprintf(pattern, sizeof(pattern), "\"%s\"", key);
	const char* at = strstr(json, pattern);
	if (!at)
		return FALSE;
	at = strchr(at + strlen(pattern), ':');
	if (!at)
		return FALSE;
	at = strchr(at, '"');
	if (!at)
		return FALSE;
	at++;
	size_t i = 0;
	while (*at && *at != '"' && i + 1 < outLen)
		out[i++] = *at++;
	out[i] = '\0';
	return TRUE;
}

static UINT32 json_number(const char* json, const char* key, UINT32 fallback)
{
	char pattern[64];
	(void)snprintf(pattern, sizeof(pattern), "\"%s\"", key);
	const char* at = strstr(json, pattern);
	if (!at)
		return fallback;
	at = strchr(at + strlen(pattern), ':');
	if (!at)
		return fallback;
	return (UINT32)strtoul(at + 1, NULL, 10);
}

static BOOL json_bool(const char* json, const char* key, BOOL fallback)
{
	char pattern[64];
	(void)snprintf(pattern, sizeof(pattern), "\"%s\"", key);
	const char* at = strstr(json, pattern);
	if (!at)
		return fallback;
	at = strchr(at + strlen(pattern), ':');
	if (!at)
		return fallback;
	while (*at == ':' || *at == ' ')
		at++;
	return strncmp(at, "true", 4) == 0;
}

static int run_session(int sock, const char* json)
{
	RDP_CLIENT_ENTRY_POINTS entry = { 0 };
	RdpClientEntry(&entry);

	rdpContext* context = freerdp_client_context_new(&entry);
	if (!context)
		return 1;

	termixContext* ctx = (termixContext*)context;
	ctx->sock = sock;

	rdpSettings* settings = context->settings;
	char buffer[512];

	if (json_string(json, "host", buffer, sizeof(buffer)))
		freerdp_settings_set_string(settings, FreeRDP_ServerHostname, buffer);
	if (json_string(json, "username", buffer, sizeof(buffer)))
		freerdp_settings_set_string(settings, FreeRDP_Username, buffer);
	if (json_string(json, "password", buffer, sizeof(buffer)))
		freerdp_settings_set_string(settings, FreeRDP_Password, buffer);
	if (json_string(json, "domain", buffer, sizeof(buffer)))
		freerdp_settings_set_string(settings, FreeRDP_Domain, buffer);

	freerdp_settings_set_uint32(settings, FreeRDP_ServerPort, json_number(json, "port", 3389));
	freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth, json_number(json, "width", 1920));
	freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight, json_number(json, "height", 1080));

	const BOOL ignoreCert = json_bool(json, "ignoreCert", TRUE);
	freerdp_settings_set_bool(settings, FreeRDP_IgnoreCertificate, ignoreCert);
	freerdp_settings_set_bool(settings, FreeRDP_AutoAcceptCertificate, ignoreCert);

	fprintf(stderr, "[%s] connecting to %s:%u as '%s' domain '%s' %ux%u\n", TAG,
	        freerdp_settings_get_string(settings, FreeRDP_ServerHostname),
	        freerdp_settings_get_uint32(settings, FreeRDP_ServerPort),
	        freerdp_settings_get_string(settings, FreeRDP_Username),
	        freerdp_settings_get_string(settings, FreeRDP_Domain),
	        freerdp_settings_get_uint32(settings, FreeRDP_DesktopWidth),
	        freerdp_settings_get_uint32(settings, FreeRDP_DesktopHeight));
	fflush(stderr);

	pthread_t reader;
	pthread_create(&reader, NULL, input_thread, ctx);
	pthread_detach(reader);

	int rc = 0;
	if (!freerdp_connect(context->instance))
	{
		/* "connect failed" on its own is unactionable: the reason is the whole
		 * diagnosis, so report FreeRDP's own error name and text. */
		const UINT32 code = freerdp_get_last_error(context);
		char message[512];
		(void)snprintf(message, sizeof(message), "freerdp_connect failed: %s (%s, 0x%08X)",
		               freerdp_get_last_error_string(code), freerdp_get_last_error_name(code),
		               code);
		fprintf(stderr, "[%s] %s\n", TAG, message);
		fflush(stderr);
		wire_error(ctx, message);
		rc = 1;
		goto cleanup;
	}

	fprintf(stderr, "[%s] connected to %s\n", TAG,
	        freerdp_settings_get_string(settings, FreeRDP_ServerHostname));
	fflush(stderr);

	/* Why the loop ends is the whole diagnosis when a session drops right after
	 * connecting, so each exit path says which one it was. */
	const char* reason = "unknown";
	for (;;)
	{
		HANDLE handles[64];
		const DWORD count =
		    freerdp_get_event_handles(context, handles, ARRAYSIZE(handles));
		if (count == 0)
		{
			reason = "freerdp_get_event_handles returned no handles";
			break;
		}

		const DWORD wait = WaitForMultipleObjects(count, handles, FALSE, INFINITE);
		if (wait == WAIT_FAILED)
		{
			reason = "WaitForMultipleObjects failed";
			break;
		}

		if (!freerdp_check_event_handles(context))
		{
			const UINT32 code = freerdp_get_last_error(context);
			static char detail[256];
			(void)snprintf(detail, sizeof(detail), "check_event_handles failed: %s (%s, 0x%08X)",
			               freerdp_get_last_error_string(code),
			               freerdp_get_last_error_name(code), code);
			reason = detail;
			break;
		}

		if (freerdp_shall_disconnect_context(context))
		{
			reason = "server requested disconnect";
			break;
		}
	}

	fprintf(stderr, "[%s] session loop ended: %s\n", TAG, reason);
	fflush(stderr);
	wire_error(ctx, reason);

	freerdp_disconnect(context->instance);

cleanup:
	freerdp_client_context_free(context);
	return rc;
}

/* ------------------------------------------------------------------ */
/* listener                                                            */
/* ------------------------------------------------------------------ */

static BOOL read_exact(int fd, void* buf, size_t len)
{
	BYTE* p = (BYTE*)buf;
	size_t got = 0;
	while (got < len)
	{
		const ssize_t n = recv(fd, p + got, len - got, 0);
		if (n <= 0)
			return FALSE;
		got += (size_t)n;
	}
	return TRUE;
}

static void handle_client(int sock)
{
	BYTE header[8];
	if (!read_exact(sock, header, sizeof(header)))
		return;
	if (memcmp(header, "CONN", 4) != 0)
		return;

	const UINT32 length = read_u32(header + 4);
	if (length == 0 || length > 64 * 1024)
		return;

	char* json = (char*)calloc(1, length + 1);
	if (!json)
		return;
	if (!read_exact(sock, json, length))
	{
		free(json);
		return;
	}

	const int flag = 1;
	setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));

	run_session(sock, json);
	free(json);
}

int main(int argc, char* argv[])
{
	const char* portEnv = getenv("BRIDGE_PORT");
	const int port = portEnv ? atoi(portEnv) : DEFAULT_PORT;

	signal(SIGPIPE, SIG_IGN);
	signal(SIGCHLD, SIG_IGN);

	const int listener = socket(AF_INET, SOCK_STREAM, 0);
	if (listener < 0)
	{
		perror("socket");
		return 1;
	}

	const int reuse = 1;
	setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));

	struct sockaddr_in addr = { 0 };
	addr.sin_family = AF_INET;
	addr.sin_addr.s_addr = htonl(INADDR_ANY);
	addr.sin_port = htons((uint16_t)port);

	if (bind(listener, (struct sockaddr*)&addr, sizeof(addr)) < 0)
	{
		perror("bind");
		return 1;
	}
	if (listen(listener, 16) < 0)
	{
		perror("listen");
		return 1;
	}

	fprintf(stderr, "[%s] listening on %d\n", TAG, port);
	fflush(stderr);

	for (;;)
	{
		const int sock = accept(listener, NULL, NULL);
		if (sock < 0)
		{
			if (errno == EINTR)
				continue;
			break;
		}

		/* One process per session: a FreeRDP crash loses that session only. */
		const pid_t pid = fork();
		if (pid == 0)
		{
			close(listener);
			handle_client(sock);
			close(sock);
			_exit(0);
		}
		close(sock);
	}

	close(listener);
	return 0;
}
