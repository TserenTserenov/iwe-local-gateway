import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { SocketTransport } from "../src/socket-transport.js";

describe("SocketTransport", () => {
  const servers: net.Server[] = [];

  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  async function makePair(): Promise<{ client: SocketTransport; server: SocketTransport }> {
    const srv = net.createServer();
    servers.push(srv);

    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as net.AddressInfo;

    const serverTransportP = new Promise<SocketTransport>((resolve) => {
      srv.once("connection", (socket) => {
        const st = new SocketTransport(socket);
        void st.start();
        resolve(st);
      });
    });

    const clientSocket = net.createConnection(port, "127.0.0.1");
    await new Promise<void>((r) => clientSocket.once("connect", r));
    const client = new SocketTransport(clientSocket);
    await client.start();

    return { client, server: await serverTransportP };
  }

  it("delivers a JSON-RPC message from client to server", async () => {
    const { client, server } = await makePair();
    const received: unknown[] = [];
    server.onmessage = (msg) => received.push(msg);

    await client.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toHaveLength(1);
    expect((received[0] as { method: string }).method).toBe("ping");
  });

  it("delivers a JSON-RPC message from server to client", async () => {
    const { client, server } = await makePair();
    const received: unknown[] = [];
    client.onmessage = (msg) => received.push(msg);

    await server.send({ jsonrpc: "2.0", id: 2, method: "pong", params: {} });
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toHaveLength(1);
    expect((received[0] as { method: string }).method).toBe("pong");
  });

  it("calls onclose when socket is destroyed", async () => {
    const { client, server } = await makePair();
    let closed = false;
    server.onclose = () => { closed = true; };

    await client.close();
    await new Promise((r) => setTimeout(r, 30));

    expect(closed).toBe(true);
  });
});
