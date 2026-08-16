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
#include <freerdp/gdi/gdi.h>
#include <freerdp/channels/channels.h>
#include <freerdp/channels/rdpgfx.h>
#include <freerdp/settings.h>
#include <winpr/synch.h>
#include <winpr/sysinfo.h>

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
	UINT32 frameCount;

	/* Surface commands per codec id, indexed by the id itself. RDPGFX ids stop
	 * at 0x0F, so this covers every one of them without a lookup. A server
	 * mixes codecs freely -- knowing the mix is what says whether the
	 * passthrough is carrying the session or only a corner of it. */
	UINT32 codecCounts[16];
	UINT32 codecOther;
	/* AVC444 updates that carried only chroma, so had no picture to forward. */
	UINT32 chromaOnlySkipped;
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

/*
 * FreeRDP's own pipeline is installed first and then partly overridden.
 *
 * Replacing the whole callback set was tried and does not work: the server
 * drops the session a couple of seconds in, before any surface command, while
 * the same host stays connected when gdi_graphics_pipeline_init owns the
 * channel. The GDI does bookkeeping the channel depends on -- surface
 * registration, cache slots, the reset/resize path -- and reimplementing all of
 * it is neither necessary nor what CLAUDE.md asks for.
 *
 * So the GDI keeps the channel, and DeactivateClientDecoding leaves its
 * SurfaceCommand null, which is exactly the slot the pass-through needs. The
 * frame callbacks are chained rather than replaced: ours emit the wire message,
 * then hand back to the GDI's.
 *
 * gfx->custom belongs to the GDI, so the session is reached through a file
 * static instead. One session per process makes that safe.
 */

static termixContext* g_session = NULL;

static const char* codec_name(UINT16 codecId)
{
	switch (codecId)
	{
		case RDPGFX_CODECID_UNCOMPRESSED:
			return "uncompressed";
		case RDPGFX_CODECID_CAVIDEO:
			return "remotefx";
		case RDPGFX_CODECID_CLEARCODEC:
			return "clearcodec";
		case RDPGFX_CODECID_CAPROGRESSIVE:
			return "progressive";
		case RDPGFX_CODECID_PLANAR:
			return "planar";
		case RDPGFX_CODECID_AVC420:
			return "avc420";
		case RDPGFX_CODECID_ALPHA:
			return "alpha";
		case RDPGFX_CODECID_CAPROGRESSIVE_V2:
			return "progressive-v2";
		case RDPGFX_CODECID_AVC444:
			return "avc444";
		case RDPGFX_CODECID_AVC444v2:
			return "avc444v2";
		default:
			return "unknown";
	}
}

/* Writes the per-codec tally as "avc420=120 clearcodec=8". Silence is the
 * symptom when a server accepts a session and sends nothing, but a session
 * that is busy in the wrong codec looks identical from a frame counter alone. */
static void log_codec_mix(termixContext* ctx)
{
	char line[256];
	size_t used = 0;

	for (UINT16 id = 0; id < ARRAYSIZE(ctx->codecCounts); id++)
	{
		if (ctx->codecCounts[id] == 0 || used >= sizeof(line))
			continue;
		const int n = snprintf(line + used, sizeof(line) - used, "%s%s=%u", used ? " " : "",
		                       codec_name(id), ctx->codecCounts[id]);
		if (n < 0)
			break;
		used += (size_t)n;
	}

	fprintf(stderr, "[%s] codec mix: %s (chroma-only skipped=%u)\n", TAG,
	        used ? line : "(nothing yet)", ctx->chromaOnlySkipped);
	fflush(stderr);
}

static pcRdpgfxCapsConfirm gdi_CapsConfirmFn = NULL;

/* Which capset the server picked decides everything downstream: AVC420 is only
 * on the table in 8.1 with AVC420_ENABLED, so a server that confirms 8.0, or
 * 8.1 without the flag, will never send H.264 no matter what the bridge does.
 * Reading it beats inferring it from which codecs happen to show up. */
static UINT tx_CapsConfirm(RdpgfxClientContext* gfx, const RDPGFX_CAPS_CONFIRM_PDU* pdu)
{
	if (pdu && pdu->capsSet)
	{
		const UINT32 version = pdu->capsSet->version;
		const UINT32 flags = pdu->capsSet->flags;
		fprintf(stderr, "[%s] caps confirmed: version=0x%08X flags=0x%08X avc420=%s\n", TAG,
		        version, flags,
		        (flags & RDPGFX_CAPS_FLAG_AVC420_ENABLED)
		            ? "enabled"
		            : ((version >= RDPGFX_CAPVERSION_10 &&
		                !(flags & RDPGFX_CAPS_FLAG_AVC_DISABLED))
		                   ? "implied"
		                   : "no"));
		fflush(stderr);
	}
	return gdi_CapsConfirmFn ? gdi_CapsConfirmFn(gfx, pdu) : CHANNEL_RC_OK;
}

static pcRdpgfxResetGraphics gdi_ResetGraphicsFn = NULL;
static pcRdpgfxCreateSurface gdi_CreateSurfaceFn = NULL;
static pcRdpgfxDeleteSurface gdi_DeleteSurfaceFn = NULL;
static pcRdpgfxMapSurfaceToOutput gdi_MapSurfaceToOutputFn = NULL;
static pcRdpgfxStartFrame gdi_StartFrameFn = NULL;
static pcRdpgfxEndFrame gdi_EndFrameFn = NULL;

static UINT tx_ResetGraphics(RdpgfxClientContext* gfx, const RDPGFX_RESET_GRAPHICS_PDU* pdu)
{
	fprintf(stderr, "[%s] reset graphics %ux%u\n", TAG, pdu->width, pdu->height);
	fflush(stderr);

	/* No HELO from here: gdi_ResetGraphics calls update->DesktopResize, and
	 * tx_desktop_resize sends it. Sending one here as well would resize the
	 * browser canvas twice, and assigning a canvas size clears it. */
	return gdi_ResetGraphicsFn ? gdi_ResetGraphicsFn(gfx, pdu) : CHANNEL_RC_OK;
}

static UINT tx_CreateSurface(RdpgfxClientContext* gfx, const RDPGFX_CREATE_SURFACE_PDU* pdu)
{
	termixContext* ctx = g_session;
	if (ctx)
	{
		BYTE payload[7];
		put_u16(payload, pdu->surfaceId);
		put_u16(payload + 2, pdu->width);
		put_u16(payload + 4, pdu->height);
		payload[6] = (BYTE)pdu->pixelFormat;
		wire_send(ctx, "SURF", payload, sizeof(payload));
	}
	return gdi_CreateSurfaceFn ? gdi_CreateSurfaceFn(gfx, pdu) : CHANNEL_RC_OK;
}

static UINT tx_DeleteSurface(RdpgfxClientContext* gfx, const RDPGFX_DELETE_SURFACE_PDU* pdu)
{
	termixContext* ctx = g_session;
	if (ctx)
	{
		BYTE payload[2];
		put_u16(payload, pdu->surfaceId);
		wire_send(ctx, "DELS", payload, sizeof(payload));
	}
	return gdi_DeleteSurfaceFn ? gdi_DeleteSurfaceFn(gfx, pdu) : CHANNEL_RC_OK;
}

static UINT tx_MapSurfaceToOutput(RdpgfxClientContext* gfx,
                                  const RDPGFX_MAP_SURFACE_TO_OUTPUT_PDU* pdu)
{
	termixContext* ctx = g_session;
	if (ctx)
	{
		BYTE payload[10];
		put_u16(payload, pdu->surfaceId);
		put_u32(payload + 2, pdu->outputOriginX);
		put_u32(payload + 6, pdu->outputOriginY);
		wire_send(ctx, "SMAP", payload, sizeof(payload));
	}
	return gdi_MapSurfaceToOutputFn ? gdi_MapSurfaceToOutputFn(gfx, pdu) : CHANNEL_RC_OK;
}

static UINT tx_StartFrame(RdpgfxClientContext* gfx, const RDPGFX_START_FRAME_PDU* pdu)
{
	termixContext* ctx = g_session;
	if (ctx)
	{
		BYTE payload[4];
		put_u32(payload, pdu->frameId);
		wire_send(ctx, "FBEG", payload, sizeof(payload));
	}
	return gdi_StartFrameFn ? gdi_StartFrameFn(gfx, pdu) : CHANNEL_RC_OK;
}

static UINT tx_EndFrame(RdpgfxClientContext* gfx, const RDPGFX_END_FRAME_PDU* pdu)
{
	termixContext* ctx = g_session;
	if (ctx)
	{
		BYTE payload[4];
		put_u32(payload, pdu->frameId);
		wire_send(ctx, "FEND", payload, sizeof(payload));
	}
	return gdi_EndFrameFn ? gdi_EndFrameFn(gfx, pdu) : CHANNEL_RC_OK;
}

/*
 * Emits one AVC420 bitstream, untouched, with the rects that place it.
 *
 * The metablock is freed the moment the surface command returns, so the rects
 * are copied into the payload here rather than referenced.
 */
static UINT send_avc_frame(termixContext* ctx, const RDPGFX_SURFACE_COMMAND* cmd,
                           const RDPGFX_AVC420_BITMAP_STREAM* avc)
{
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

	ctx->frameCount++;
	wire_send(ctx, "AVCF", payload, (UINT32)total);
	free(payload);
	return CHANNEL_RC_OK;
}

/*
 * The pass-through.
 *
 * AVC420 is the simple case: cmd->extra is the bitstream exactly as it came off
 * the wire.
 *
 * AVC444 needs one decision. Asking for the 10.x capsets is the only way to get
 * H.264 out of a current Windows server, and those imply 4:4:4 -- which browser
 * decoders reject. But a 4:4:4 frame is carried as two ordinary AVC420 streams:
 * a full 4:2:0 picture plus an auxiliary one holding the extra chroma. Sending
 * the first and dropping the second yields 4:2:0, which is what CLAUDE.md asks
 * for, and keeps the bitstream untouched -- no decode, no re-encode.
 *
 * LC says which stream is in bitstream[0] (libfreerdp/codec/h264.c:572):
 *   0 - luma, with chroma in bitstream[1]
 *   1 - luma alone
 *   2 - chroma alone, and there is no luma to send
 *
 * LC=2 must be skipped rather than passed on: bitstream[0] holds chroma there,
 * and feeding it to a decoder expecting a picture paints garbage.
 */
static UINT tx_SurfaceCommand(RdpgfxClientContext* gfx, const RDPGFX_SURFACE_COMMAND* cmd)
{
	WINPR_UNUSED(gfx);
	termixContext* ctx = g_session;
	if (!ctx)
		return CHANNEL_RC_OK;

	if (cmd->codecId < ARRAYSIZE(ctx->codecCounts))
	{
		if (ctx->codecCounts[cmd->codecId]++ == 0)
		{
			fprintf(stderr, "[%s] first %s surface command: %ux%u\n", TAG,
			        codec_name(cmd->codecId), (unsigned)cmd->width, (unsigned)cmd->height);
			fflush(stderr);
		}
	}
	else
		ctx->codecOther++;

	if (cmd->codecId == RDPGFX_CODECID_AVC420)
		return send_avc_frame(ctx, cmd, (const RDPGFX_AVC420_BITMAP_STREAM*)cmd->extra);

	if (cmd->codecId == RDPGFX_CODECID_AVC444 || cmd->codecId == RDPGFX_CODECID_AVC444v2)
	{
		const RDPGFX_AVC444_BITMAP_STREAM* bs = (const RDPGFX_AVC444_BITMAP_STREAM*)cmd->extra;
		if (!bs)
			return CHANNEL_RC_OK;

		if (bs->LC == 2)
		{
			ctx->chromaOnlySkipped++;
			return CHANNEL_RC_OK;
		}

		return send_avc_frame(ctx, cmd, &bs->bitstream[0]);
	}

	/* Anything else is skipped, not fatal. Windows mixes codecs: small
	 * non-video updates arrive as ClearCodec or Planar even when H.264 is
	 * negotiated, so failing the session on the first one kills it on the lock
	 * screen before the desktop ever draws. Those regions simply do not update
	 * yet -- what to do about them is a decision for the measured mix, which
	 * the periodic histogram reports. */
	return CHANNEL_RC_OK;
}

static void tx_OnChannelConnected(void* context, const ChannelConnectedEventArgs* e)
{
	if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) == 0)
	{
		/* Let the GDI take the channel first, then take back only what the
		 * pass-through needs. */
		freerdp_client_OnChannelConnectedEventHandler(context, e);

		RdpgfxClientContext* gfx = (RdpgfxClientContext*)e->pInterface;
		if (g_session)
			g_session->gfx = gfx;

		gdi_ResetGraphicsFn = gfx->ResetGraphics;
		gdi_CreateSurfaceFn = gfx->CreateSurface;
		gdi_DeleteSurfaceFn = gfx->DeleteSurface;
		gdi_MapSurfaceToOutputFn = gfx->MapSurfaceToOutput;
		gdi_StartFrameFn = gfx->StartFrame;
		gdi_EndFrameFn = gfx->EndFrame;
		gdi_CapsConfirmFn = gfx->CapsConfirm;

		gfx->CapsConfirm = tx_CapsConfirm;
		gfx->ResetGraphics = tx_ResetGraphics;
		gfx->CreateSurface = tx_CreateSurface;
		gfx->DeleteSurface = tx_DeleteSurface;
		gfx->MapSurfaceToOutput = tx_MapSurfaceToOutput;
		gfx->StartFrame = tx_StartFrame;
		gfx->EndFrame = tx_EndFrame;

		/* DeactivateClientDecoding leaves this null, which is why the frames
		 * can be taken without the library ever decoding one. */
		gfx->SurfaceCommand = tx_SurfaceCommand;

		fprintf(stderr, "[%s] graphics pipeline attached (gdi bookkeeping + avc420 passthrough)\n",
		        TAG);
		fflush(stderr);
	}
	else
		freerdp_client_OnChannelConnectedEventHandler(context, e);
}

static void tx_OnChannelDisconnected(void* context, const ChannelDisconnectedEventArgs* e)
{
	if (strcmp(e->name, RDPGFX_DVC_CHANNEL_NAME) == 0 && g_session)
		g_session->gfx = NULL;

	freerdp_client_OnChannelDisconnectedEventHandler(context, e);
}

/* ------------------------------------------------------------------ */
/* connection lifecycle                                                */
/* ------------------------------------------------------------------ */

static BOOL tx_pre_connect(freerdp* instance)
{
	rdpContext* context = instance->context;
	rdpSettings* settings = context->settings;

	/* Advertising AVC444 is what puts the CAPVERSION_10.x sets on the wire:
	 * FreeRDP gates them behind "if (!GfxH264 || GfxAVC444)" (rdpgfx_main.c),
	 * so asking for AVC420 alone advertises only 8.0 and 8.1. A current Windows
	 * server answers that with 8.0, which has no H.264 at all -- measured
	 * against Windows 11: 8.0 confirmed, nothing but ClearCodec and progressive
	 * arrived. With the 10.x sets it confirms 10.7 and sends H.264.
	 *
	 * 4:4:4 is not what gets rendered, though. tx_SurfaceCommand forwards only
	 * the luma stream of an AVC444 frame, which is an ordinary 4:2:0 picture, so
	 * the browser still receives something it can decode and the bitstream is
	 * still never touched. BRIDGE_GFX_AVC444=0 restores AVC420-only for
	 * servers that do offer H.264 on 8.1. */
	const char* avc444Env = getenv("BRIDGE_GFX_AVC444");
	const BOOL wantAvc444 = !(avc444Env && avc444Env[0] == '0');
	if (!wantAvc444)
	{
		fprintf(stderr, "[%s] BRIDGE_GFX_AVC444=0: advertising 8.0/8.1 only\n", TAG);
		fflush(stderr);
	}

	if (!freerdp_settings_set_bool(settings, FreeRDP_SupportGraphicsPipeline, TRUE) ||
	    !freerdp_settings_set_bool(settings, FreeRDP_GfxH264, TRUE) ||
	    !freerdp_settings_set_bool(settings, FreeRDP_GfxAVC444, wantAvc444) ||
	    !freerdp_settings_set_bool(settings, FreeRDP_GfxAVC444v2, wantAvc444) ||
	    !freerdp_settings_set_bool(settings, FreeRDP_GfxProgressive, FALSE) ||
	    !freerdp_settings_set_bool(settings, FreeRDP_GfxSmallCache, FALSE) ||
	    !freerdp_settings_set_bool(settings, FreeRDP_GfxThinClient, FALSE))
		return FALSE;

	if (!freerdp_settings_set_uint32(settings, FreeRDP_ColorDepth, 32))
		return FALSE;

	/* A non-zero filter would drop capsets before they are ever advertised,
	 * which would look identical to a server refusing them. */
	fprintf(stderr, "[%s] gfx caps filter=0x%08X avc444=%s\n", TAG,
	        freerdp_settings_get_uint32(settings, FreeRDP_GfxCapsFilter),
	        wantAvc444 ? "yes" : "no");
	fflush(stderr);

	/* These return an int and signal failure with a negative value; treating
	 * the result as a boolean rejects the success case. */
	if (PubSub_SubscribeChannelConnected(context->pubSub, tx_OnChannelConnected) < 0)
		return FALSE;
	if (PubSub_SubscribeChannelDisconnected(context->pubSub, tx_OnChannelDisconnected) < 0)
		return FALSE;

	return TRUE;
}

/* gdi_ResetGraphics calls update->DesktopResize unconditionally and asserts
 * that it is set (libfreerdp/gdi/gfx.c:121). Leaving it NULL aborts the whole
 * process from the channel thread on the server's first ResetGraphics PDU --
 * before a single surface is created -- which looks exactly like a server that
 * connects and then never sends graphics. It is the one update callback gfx.c
 * touches; the sample client registers the same handler.
 *
 * This owns the HELO for both resize paths: the gfx one above, and a
 * server-initiated deactivate/reactivate, which never reaches ResetGraphics. */
static BOOL tx_desktop_resize(rdpContext* context)
{
	termixContext* ctx = (termixContext*)context;
	rdpSettings* settings = context->settings;
	const UINT32 width = freerdp_settings_get_uint32(settings, FreeRDP_DesktopWidth);
	const UINT32 height = freerdp_settings_get_uint32(settings, FreeRDP_DesktopHeight);

	ctx->desktopWidth = width;
	ctx->desktopHeight = height;

	BYTE payload[8];
	put_u32(payload, width);
	put_u32(payload + 4, height);
	wire_send(ctx, "HELO", payload, sizeof(payload));

	fprintf(stderr, "[%s] desktop resize %ux%u\n", TAG, width, height);
	fflush(stderr);

	return gdi_resize(context->gdi, width, height);
}

static BOOL tx_post_connect(freerdp* instance)
{
	termixContext* ctx = (termixContext*)instance->context;
	rdpSettings* settings = instance->context->settings;

	/* The core needs a GDI even though nothing here draws into it: without one
	 * the update path is unset and the transport read loop spins until it gives
	 * up with "BIO_read retries exceeded".
	 *
	 * DeactivateClientDecoding then stops the library allocating codecs and
	 * decoding anything, which is FreeRDP's own supported way to parse the
	 * protocol without processing graphics. The gdi does own the gfx channel
	 * and its surface bookkeeping, but DeactivateClientDecoding leaves its
	 * SurfaceCommand NULL, which is the slot the H.264 passes through
	 * untouched. This mirrors the sample client's post_connect. */
	if (!gdi_init(instance, PIXEL_FORMAT_XRGB32))
	{
		wire_error(ctx, "gdi_init failed");
		return FALSE;
	}
	if (!freerdp_settings_set_bool(settings, FreeRDP_DeactivateClientDecoding, TRUE))
		return FALSE;

	instance->context->update->DesktopResize = tx_desktop_resize;

	ctx->desktopWidth = freerdp_settings_get_uint32(settings, FreeRDP_DesktopWidth);
	ctx->desktopHeight = freerdp_settings_get_uint32(settings, FreeRDP_DesktopHeight);

	BYTE payload[8];
	put_u32(payload, ctx->desktopWidth);
	put_u32(payload + 4, ctx->desktopHeight);
	wire_send(ctx, "HELO", payload, sizeof(payload));
	fprintf(stderr, "[%s] post_connect sent HELO %ux%u\n", TAG, ctx->desktopWidth,
	        ctx->desktopHeight);
	fflush(stderr);

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
	/* FACK is accepted and ignored: rdpgfx_recv_end_frame_pdu acknowledges
	 * frames itself, so sending a second one from here would be wrong. The
	 * browser still sends it, and it still marks how far it has decoded. */
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

/*
 * RDP desktop dimensions must be even and within 200..8192; a browser surface
 * is neither by nature. An odd size is accepted at connect time and then the
 * server drops the session a couple of seconds later, which surfaces as a
 * clean EOF on the transport rather than anything that names the real cause.
 */
static UINT32 sanitize_dimension(UINT32 value, UINT32 fallback)
{
	if (value < 200 || value > 8192)
		value = fallback;
	return value & ~1u;
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
	g_session = ctx;

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
	freerdp_settings_set_uint32(settings, FreeRDP_DesktopWidth,
	                            sanitize_dimension(json_number(json, "width", 1920), 1920));
	freerdp_settings_set_uint32(settings, FreeRDP_DesktopHeight,
	                            sanitize_dimension(json_number(json, "height", 1080), 1080));

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
	UINT32 idleSeconds = 0;
	UINT64 statsTick = GetTickCount64();
	UINT32 statsFrames = 0;
	for (;;)
	{
		/* A busy session never goes idle, so the frame rate has to be reported
		 * on a clock rather than off the idle branch -- and the frame rate is
		 * the number this whole path exists to move. */
		const UINT64 now = GetTickCount64();
		if (now - statsTick >= 5000)
		{
			const UINT32 delta = ctx->frameCount - statsFrames;
			fprintf(stderr, "[%s] %.1f fps (%u frames in %llums)\n", TAG,
			        (double)delta * 1000.0 / (double)(now - statsTick), delta,
			        (unsigned long long)(now - statsTick));
			fflush(stderr);
			log_codec_mix(ctx);
			statsTick = now;
			statsFrames = ctx->frameCount;
		}

		HANDLE handles[64];
		const DWORD count =
		    freerdp_get_event_handles(context, handles, ARRAYSIZE(handles));
		if (count == 0)
		{
			reason = "freerdp_get_event_handles returned no handles";
			break;
		}

		const DWORD wait = WaitForMultipleObjects(count, handles, FALSE, 1000);
		if (wait == WAIT_FAILED)
		{
			reason = "WaitForMultipleObjects failed";
			break;
		}

		if (wait == WAIT_TIMEOUT)
		{
			/* Nothing happened this second. Say so periodically: silence here
			 * is itself the symptom when a server accepts the session and then
			 * never sends a frame. */
			if (++idleSeconds % 5 == 0)
			{
				fprintf(stderr, "[%s] idle %us, frames=%u\n", TAG, idleSeconds,
				        ctx->frameCount);
				fflush(stderr);
			}
			if (freerdp_shall_disconnect_context(context))
			{
				reason = "server requested disconnect";
				break;
			}
			continue;
		}
		idleSeconds = 0;

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
